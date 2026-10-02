import { ImportsService } from './imports.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
describe('análisis de archivos CSV', () => {
  const service = new ImportsService({} as PrismaService, {} as AuditService);
  it('rechaza cabeceras duplicadas tras normalizar alias', () => {
    const csv = 'customer_id,cliente_id,transaction_id,amount,date\nc1,c2,t1,10,2026-01-01';
    expect(service.analyze(Buffer.from(csv)).report.fatal).toBeDefined();
  });
  it('detecta duplicados y filas inválidas sin escribir datos', () => {
    const csv =
      'customer_id,transaction_id,amount,date\nc1,t1,10,2026-01-01\nc1,t1,10,2026-01-01\nc1,t2,-5,2026-01-01';
    const { report, rows } = service.analyze(Buffer.from(csv));
    expect(rows).toHaveLength(1);
    expect(report).toMatchObject({
      totalRows: 3,
      validRows: 1,
      rejectedRows: 2,
      duplicatesInFile: 1,
      dryRun: true,
    });
  });
});
