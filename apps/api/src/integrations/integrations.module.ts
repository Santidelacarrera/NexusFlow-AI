import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Client, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { getEnv } from '../common/config/env';
import { zod } from '../common/http/zod.pipe';
import { encryptSecret } from '../common/security/crypto';
import { validateUrlSyntax } from '../common/security/ssrf';

const body = z.object({
  name: z.string().trim().min(2).max(100),
  baseUrl: z.string().url().max(2048),
  headers: z
    .record(
      z.string().regex(/^[\w-]{1,64}$/),
      z
        .string()
        .max(2000)
        .refine((v) => !/[\r\n]/.test(v)),
    )
    .refine((v) => Object.keys(v).length <= 20),
});
const idSchema = z.string().regex(/^[a-z0-9]{20,40}$/);
const safe = { id: true, name: true, baseUrl: true, createdAt: true } as const;
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}
  list(orgId: string) {
    return this.prisma.integration.findMany({
      where: { orgId },
      select: safe,
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
  }
  async create(u: AuthUser, dto: z.infer<typeof body>, client: ClientInfo) {
    const env = getEnv(),
      allowlist = env.HTTP_ACTION_ALLOWLIST.split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    if (!allowlist.length) throw new BadRequestException('El operador debe configurar HTTP_ACTION_ALLOWLIST');
    try {
      validateUrlSyntax(dto.baseUrl, { allowlist });
    } catch {
      throw new BadRequestException('URL fuera de la política de conexiones');
    }
    if (
      Object.keys(dto.headers).some((k) =>
        [
          'host',
          'content-length',
          'connection',
          'transfer-encoding',
          'upgrade',
          'proxy-authorization',
        ].includes(k.toLowerCase()),
      )
    )
      throw new BadRequestException('Cabecera no permitida');
    if ((await this.prisma.integration.count({ where: { orgId: u.orgId } })) >= 100)
      throw new BadRequestException('Máximo 100 integraciones');
    // CUID generado por Prisma primero con ciphertext temporal; se sustituye antes de commit.
    const integration = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.integration.create({
        data: { orgId: u.orgId, name: dto.name, baseUrl: new URL(dto.baseUrl).origin, headersEnc: '' },
      });
      return tx.integration.update({
        where: { id: entry.id },
        data: { headersEnc: encryptSecret(JSON.stringify(dto.headers), env.DATA_ENCRYPTION_KEY, entry.id) },
        select: safe,
      });
    });
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'integration.create',
      resource: 'integration',
      resourceId: integration.id,
      client,
    });
    return integration;
  }
  async remove(u: AuthUser, id: string, client: ClientInfo) {
    const deleted = await this.prisma.integration.deleteMany({ where: { orgId: u.orgId, id } });
    if (!deleted.count) throw new NotFoundException();
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'integration.delete',
      resourceId: id,
      client,
    });
  }
}
@Controller('integrations')
class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}
  @Get() list(@CurrentUser() u: AuthUser) {
    return this.integrations.list(u.orgId);
  }
  @Roles('ADMIN') @Post() create(
    @CurrentUser() u: AuthUser,
    @Body(zod(body)) dto: z.infer<typeof body>,
    @Client() c: ClientInfo,
  ) {
    return this.integrations.create(u, dto, c);
  }
  @Roles('ADMIN') @HttpCode(204) @Delete(':id') remove(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(idSchema)) id: string,
    @Client() c: ClientInfo,
  ) {
    return this.integrations.remove(u, id, c);
  }
}
@Module({ controllers: [IntegrationsController], providers: [IntegrationsService] })
export class IntegrationsModule {}
