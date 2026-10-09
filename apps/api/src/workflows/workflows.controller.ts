import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AnalyticsModule } from '../analytics/analytics.module';
import { Client, CurrentUser, Public, Roles } from '../common/http/decorators';
import type { AuthedRequest, AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { hmacHex, safeEqual } from '../common/security/crypto';
import { OperationsModule } from '../operations/operations.module';
import { TriggersService } from '../triggers/triggers.module';
import {
  ReportsService,
  WorkflowRunner,
  WorkflowsService,
  workflowInput,
  type WorkflowInput,
} from './workflows.service';

const cuid = z.string().regex(/^[a-z0-9]{20,40}$/);
const page = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  workflowId: cuid.optional(),
});
const runBody = z.object({ payload: z.record(z.string(), z.unknown()).default({}) });

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly svc: WorkflowsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.orgId);
  }

  @Get('stats')
  stats(@CurrentUser() u: AuthUser) {
    return this.svc.stats(u.orgId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string) {
    return this.svc.get(u.orgId, id);
  }

  @Roles('ANALYST')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body(zod(workflowInput)) dto: WorkflowInput, @Client() c: ClientInfo) {
    return this.svc.create(u, dto, c);
  }

  @Roles('ANALYST')
  @Put(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(cuid)) id: string,
    @Body(zod(workflowInput)) dto: WorkflowInput,
    @Client() c: ClientInfo,
  ) {
    return this.svc.update(u, id, dto, c);
  }

  @Roles('ANALYST')
  @HttpCode(200)
  @Post(':id/activate')
  activate(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string, @Client() c: ClientInfo) {
    return this.svc.setStatus(u, id, 'ACTIVE', c);
  }

  @Roles('ANALYST')
  @HttpCode(200)
  @Post(':id/pause')
  pause(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string, @Client() c: ClientInfo) {
    return this.svc.setStatus(u, id, 'PAUSED', c);
  }

  @Roles('ADMIN')
  @HttpCode(204)
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string, @Client() c: ClientInfo) {
    await this.svc.remove(u, id, c);
  }

  @Roles('ADMIN')
  @HttpCode(200)
  @Post(':id/webhook-secret')
  rotate(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string, @Client() c: ClientInfo) {
    return this.svc.rotateSecret(u, id, c);
  }

  @Roles('ANALYST')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/run')
  run(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(cuid)) id: string,
    @Body(zod(runBody)) dto: z.infer<typeof runBody>,
    @Client() c: ClientInfo,
  ) {
    return this.svc.runManual(u, id, dto.payload, c);
  }
}

@Controller('runs')
export class RunsController {
  constructor(private readonly svc: WorkflowsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query(zod(page)) q: z.infer<typeof page>) {
    return this.svc.listRuns(u.orgId, q.page, q.pageSize, q.workflowId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string) {
    return this.svc.getRun(u.orgId, id);
  }

  @Roles('ANALYST')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string, @Client() c: ClientInfo) {
    return this.svc.cancelRun(u, id, c);
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles('ANALYST')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('generate')
  generate(@CurrentUser() u: AuthUser) {
    return this.reports.generate(u.orgId);
  }
}

const REPLAY_WINDOW_S = 300;
const seenSignatures = new Map<string, number>();

function rememberSignature(sig: string, nowS: number): boolean {
  for (const [k, exp] of seenSignatures) if (exp < nowS) seenSignatures.delete(k);
  if (seenSignatures.has(sig)) return false;
  if (seenSignatures.size > 10_000) return false;
  seenSignatures.set(sig, nowS + REPLAY_WINDOW_S);
  return true;
}

/**
 * Webhook entrante. Autenticación: HMAC-SHA256 sobre `${timestamp}.${cuerpo crudo}` con el secreto del workflow,
 * ventana anti-replay de 5 min y rechazo de firmas repetidas. Respuesta uniforme 401 para no filtrar qué ids existen.
 */
@Controller('hooks')
export class HooksController {
  constructor(
    private readonly svc: WorkflowsService,
    private readonly triggers: TriggersService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(202)
  @Post(':webhookId')
  async receive(@Param('webhookId') webhookId: string, @Req() req: AuthedRequest) {
    const deny = () => new UnauthorizedException('Firma inválida');
    if (!/^[\w-]{10,64}$/.test(webhookId)) throw deny();
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (raw.length === 0 || raw.length > 100_000) throw new BadRequestException('Cuerpo inválido');

    const target = await this.svc.webhookTarget(webhookId);
    const ts = Number(req.headers['x-nexus-timestamp']);
    const sigHeader = String(req.headers['x-nexus-signature'] ?? '');
    const nowS = Math.floor(Date.now() / 1000);
    const secret = target?.secret ?? 'x'.repeat(32);
    const expected = `sha256=${hmacHex(secret, `${ts}.${raw.toString('utf8')}`)}`;
    const ok =
      !!target &&
      Number.isFinite(ts) &&
      Math.abs(nowS - ts) <= REPLAY_WINDOW_S &&
      safeEqual(expected, sigHeader);
    if (!ok || !rememberSignature(sigHeader, nowS)) throw deny();

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('JSON inválido');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      throw new BadRequestException('El payload debe ser un objeto JSON');
    const runId = await this.triggers.dispatch(
      (target as NonNullable<typeof target>).workflow,
      'webhook',
      payload,
      `hook:${webhookId}:${sigHeader}`,
    );
    if (!runId) throw new BadRequestException('Cola saturada, reintenta más tarde');
    return { runId };
  }
}

@Module({
  imports: [AnalyticsModule, OperationsModule],
  controllers: [WorkflowsController, RunsController, ReportsController, HooksController],
  providers: [WorkflowsService, WorkflowRunner, ReportsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
