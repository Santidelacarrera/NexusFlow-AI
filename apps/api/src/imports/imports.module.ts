import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { parse } from 'csv-parse/sync';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Client, CurrentUser, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeHeader, REQUIRED_COLUMNS, validateRow, type ValidTransactionRow } from './csv-rules';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 50_000;
const CHUNK = 1000;

export interface ImportReport {
  dryRun: boolean;
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  importedRows: number;
  skippedExisting: number;
  duplicatesInFile: number;
  errors: Array<{ row: number; errors: string[] }>;
  inconsistencies: Array<{ type: string; detail: string }>;
  fatal?: string;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Parseo + validación puros (sin BD). Útil para el modo "dry run" de AutoOps. */
  analyze(buffer: Buffer, now = new Date()): { report: ImportReport; rows: ValidTransactionRow[] } {
    const report: ImportReport = {
      dryRun: true,
      totalRows: 0,
      validRows: 0,
      rejectedRows: 0,
      importedRows: 0,
      skippedExisting: 0,
      duplicatesInFile: 0,
      errors: [],
      inconsistencies: [],
    };
    if (buffer.includes(0))
      return { report: { ...report, fatal: 'El archivo no parece ser un CSV de texto' }, rows: [] };

    let records: Array<Record<string, string>>;
    try {
      records = parse(buffer, {
        columns: (header: string[]) => {
          const normalized = header.map(normalizeHeader);
          if (new Set(normalized).size !== normalized.length) throw new Error('Columnas duplicadas');
          return normalized;
        },
        bom: true,
        skip_empty_lines: true,
        trim: true,
        max_record_size: 10_000,
        to: MAX_ROWS + 1,
        relax_column_count: false,
      });
    } catch {
      return {
        report: { ...report, fatal: 'CSV mal formado (columnas inconsistentes o comillas sin cerrar)' },
        rows: [],
      };
    }
    if (records.length > MAX_ROWS)
      return { report: { ...report, fatal: `El archivo supera el máximo de ${MAX_ROWS} filas` }, rows: [] };
    if (records.length === 0)
      return { report: { ...report, fatal: 'El archivo no contiene filas' }, rows: [] };

    const columns = Object.keys(records[0]);
    const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
    if (missing.length)
      return {
        report: { ...report, fatal: `Faltan columnas obligatorias: ${missing.join(', ')}` },
        rows: [],
      };

    const rows: ValidTransactionRow[] = [];
    const seenTx = new Set<string>();
    const emailByCustomer = new Map<string, string>();
    report.totalRows = records.length;

    records.forEach((rec, i) => {
      const res = validateRow(rec, now);
      if (!res.ok) {
        report.rejectedRows++;
        if (report.errors.length < 100) report.errors.push({ row: i + 2, errors: res.errors });
        return;
      }
      const v = res.value;
      if (seenTx.has(v.transactionId)) {
        report.duplicatesInFile++;
        report.rejectedRows++;
        if (report.errors.length < 100)
          report.errors.push({
            row: i + 2,
            errors: [`transaction_id duplicado en el archivo: ${v.transactionId}`],
          });
        return;
      }
      seenTx.add(v.transactionId);
      if (v.email) {
        const prev = emailByCustomer.get(v.customerExternalId);
        if (prev && prev !== v.email && report.inconsistencies.length < 50) {
          report.inconsistencies.push({
            type: 'email_mismatch',
            detail: `Cliente ${v.customerExternalId} aparece con emails distintos (${prev} / ${v.email})`,
          });
        }
        emailByCustomer.set(v.customerExternalId, prev ?? v.email);
      }
      rows.push(v);
    });
    report.validRows = rows.length;
    return { report, rows };
  }

  async importTransactions(
    user: AuthUser,
    file: Express.Multer.File,
    dryRun: boolean,
    client: ClientInfo,
  ): Promise<ImportReport> {
    const { report, rows } = this.analyze(file.buffer);
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: user.orgId },
      select: { currency: true },
    });
    if (rows.some((r) => r.currency !== org.currency))
      report.fatal = `La moneda de todas las filas debe ser ${org.currency}. Convierte los importes antes de importar.`;
    report.dryRun = dryRun;
    const filename = file.originalname.replace(/[^\w.\- ]/g, '_').slice(0, 120);

    if (!report.fatal && !dryRun && rows.length > 0) {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.orgId + ':imports'}))`;
          const customers = new Map<string, ValidTransactionRow>();
          for (const r of rows)
            if (!customers.has(r.customerExternalId)) customers.set(r.customerExternalId, r);

          const extIds = [...customers.keys()];
          for (let i = 0; i < extIds.length; i += CHUNK) {
            await tx.customer.createMany({
              data: extIds.slice(i, i + CHUNK).map((id) => {
                const c = customers.get(id) as ValidTransactionRow;
                return { orgId: user.orgId, externalId: id, name: c.customerName, email: c.email };
              }),
              skipDuplicates: true,
            });
          }
          const idMap = new Map<string, string>();
          for (let i = 0; i < extIds.length; i += CHUNK) {
            const found = await tx.customer.findMany({
              where: { orgId: user.orgId, externalId: { in: extIds.slice(i, i + CHUNK) } },
              select: { id: true, externalId: true },
            });
            found.forEach((c) => idMap.set(c.externalId, c.id));
          }
          for (let i = 0; i < rows.length; i += CHUNK) {
            const res = await tx.transaction.createMany({
              data: rows.slice(i, i + CHUNK).map((r) => ({
                orgId: user.orgId,
                customerId: idMap.get(r.customerExternalId) as string,
                externalId: r.transactionId,
                amount: r.amount,
                currency: r.currency,
                occurredAt: r.occurredAt,
              })),
              skipDuplicates: true,
            });
            report.importedRows += res.count;
          }
          report.skippedExisting = report.validRows - report.importedRows;
        },
        { timeout: 60000 },
      );
    }

    if (!dryRun) {
      const status =
        report.fatal || report.importedRows + report.skippedExisting === 0
          ? 'REJECTED'
          : report.rejectedRows > 0
            ? 'COMPLETED_WITH_ERRORS'
            : 'COMPLETED';
      await this.prisma.importJob.create({
        data: {
          orgId: user.orgId,
          userId: user.id,
          kind: 'transactions',
          filename,
          status,
          totalRows: report.totalRows,
          importedRows: report.importedRows,
          rejectedRows: report.rejectedRows,
          report: JSON.parse(JSON.stringify(report)),
        },
      });
      await this.audit.record({
        orgId: user.orgId,
        userId: user.id,
        action: 'import.transactions',
        resource: 'import',
        client,
        metadata: {
          filename,
          status,
          totalRows: report.totalRows,
          importedRows: report.importedRows,
          rejectedRows: report.rejectedRows,
        },
      });
    }
    return report;
  }

  list(orgId: string) {
    return this.prisma.importJob.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        filename: true,
        status: true,
        totalRows: true,
        importedRows: true,
        rejectedRows: true,
        createdAt: true,
      },
    });
  }

  async detail(orgId: string, id: string) {
    return this.prisma.importJob.findFirst({ where: { id, orgId } });
  }
}

const querySchema = z.object({ dryRun: z.enum(['true', 'false']).default('false') });

@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Roles('ANALYST')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('transactions')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 },
      fileFilter: (_req, file, cb) => {
        const okName = /\.csv$/i.test(file.originalname);
        const okMime = ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'].includes(
          file.mimetype,
        );
        cb(
          okName && okMime ? null : new UnsupportedMediaTypeException('Solo se aceptan archivos .csv'),
          okName && okMime,
        );
      },
    }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query(zod(querySchema)) q: z.infer<typeof querySchema>,
    @Client() client: ClientInfo,
  ) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file")');
    return this.imports.importTransactions(user, file, q.dryRun === 'true', client);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.imports.list(user.orgId);
  }

  @Get('latest')
  async latest(@CurrentUser() user: AuthUser) {
    const [first] = await this.imports.list(user.orgId);
    return first ? this.imports.detail(user.orgId, first.id) : null;
  }
}

@Module({ controllers: [ImportsController], providers: [ImportsService], exports: [ImportsService] })
export class ImportsModule {}
