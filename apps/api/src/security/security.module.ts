import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Client, CurrentUser, Public, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { randomToken, sha256Hex } from '../common/security/crypto';

const idSchema = z.string().regex(/^[a-z0-9]{20,40}$/);
const campaignBody = z.object({
  name: z.string().trim().min(3).max(100),
  authorizationRef: z.string().trim().min(5).max(200),
  userIds: z
    .array(idSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});
const eventBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),
  event: z.enum(['clicked', 'reported']),
});
const paging = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().max(100).optional(),
});

@Injectable()
export class SecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}
  async campaigns(orgId: string) {
    const campaigns = await this.prisma.phishingCampaign.findMany({
      where: { orgId },
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: { targets: { select: { clickedAt: true, reportedAt: true } } },
    });
    return campaigns.map(({ targets, ...c }) => ({
      ...c,
      recipients: targets.length,
      clicks: targets.filter((t) => t.clickedAt).length,
      reports: targets.filter((t) => t.reportedAt).length,
    }));
  }
  async create(u: AuthUser, dto: z.infer<typeof campaignBody>, client: ClientInfo) {
    const targets = await this.prisma.user.findMany({
      where: { orgId: u.orgId, isActive: true, id: { in: dto.userIds } },
      select: { id: true, name: true },
    });
    if (targets.length !== dto.userIds.length) throw new BadRequestException('Destinatarios inválidos');
    const tokens = targets.map((t) => ({ ...t, token: randomToken(32) }));
    const campaign = await this.prisma.phishingCampaign.create({
      data: {
        orgId: u.orgId,
        name: dto.name,
        authorizationRef: dto.authorizationRef,
        createdBy: u.id,
        templateKey: 'awareness-v1',
        status: 'RUNNING',
        targets: {
          create: tokens.map((t) => ({ userId: t.id, tokenHash: sha256Hex(t.token), sentAt: null })),
        },
      },
    });
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'security.campaign.create',
      resourceId: campaign.id,
      client,
      metadata: { authorizationRef: dto.authorizationRef, recipients: targets.length },
    });
    // Entrega manual: ningún correo sale automáticamente. Los enlaces se muestran una sola vez.
    return { ...campaign, links: tokens.map((t) => ({ name: t.name, path: `/training#${t.token}` })) };
  }
  async close(u: AuthUser, id: string, client: ClientInfo) {
    const r = await this.prisma.phishingCampaign.updateMany({
      where: { id, orgId: u.orgId },
      data: { status: 'CLOSED' },
    });
    if (!r.count) throw new NotFoundException();
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'security.campaign.close',
      resourceId: id,
      client,
    });
    return { id, status: 'CLOSED' };
  }
  async event(dto: z.infer<typeof eventBody>) {
    const target = await this.prisma.phishingTarget.findUnique({
      where: { tokenHash: sha256Hex(dto.token) },
      include: { campaign: true },
    });
    if (
      !target ||
      target.campaign.status !== 'RUNNING' ||
      target.campaign.createdAt.getTime() < Date.now() - 30 * 86400000
    )
      throw new NotFoundException('Enlace caducado');
    const field = dto.event === 'clicked' ? 'clickedAt' : 'reportedAt';
    await this.prisma.phishingTarget.updateMany({
      where: { id: target.id, [field]: null },
      data: { [field]: new Date() },
    });
    return {
      message:
        'Simulación educativa. Verifica el remitente y reporta enlaces sospechosos. Nunca entregues tus contraseñas.',
    };
  }
}
@Controller('security')
class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly audit: AuditService,
  ) {}
  @Roles('ADMIN') @Get('audit') list(
    @CurrentUser() u: AuthUser,
    @Query(zod(paging)) q: z.infer<typeof paging>,
  ) {
    return this.audit.list(u.orgId, q.page, q.pageSize, q.action);
  }
  @Roles('ADMIN') @Post('audit/verify') verify(@CurrentUser() u: AuthUser) {
    return this.audit.verify(u.orgId);
  }
  @Roles('ADMIN') @Get('campaigns') campaigns(@CurrentUser() u: AuthUser) {
    return this.security.campaigns(u.orgId);
  }
  @Roles('ADMIN') @Post('campaigns') create(
    @CurrentUser() u: AuthUser,
    @Body(zod(campaignBody)) dto: z.infer<typeof campaignBody>,
    @Client() c: ClientInfo,
  ) {
    return this.security.create(u, dto, c);
  }
  @Roles('ADMIN') @Post('campaigns/:id/close') close(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(idSchema)) id: string,
    @Client() c: ClientInfo,
  ) {
    return this.security.close(u, id, c);
  }
  @Public() @Post('training/event') event(@Body(zod(eventBody)) dto: z.infer<typeof eventBody>) {
    return this.security.event(dto);
  }
}
@Module({ controllers: [SecurityController], providers: [SecurityService] })
export class SecurityModule {}
