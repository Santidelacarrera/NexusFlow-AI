import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsModule, AnalyticsService } from '../analytics/analytics.module';
import { AuditService } from '../audit/audit.service';
import { TriggersService } from '../triggers/triggers.module';
import { getEnv } from '../common/config/env';
import { Client, CurrentUser, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';

const policyBody = z.object({
  threshold: z.number().min(0.1).max(0.99),
  enabled: z.boolean(),
  action: z.enum(['TASK', 'ALERT']),
});
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const mlResponse = z.object({
  version: z.string().max(100),
  mode: z.enum(['trained', 'heuristic']),
  metrics: z.record(z.string(), z.unknown()),
  predictions: z
    .array(
      z.object({
        customerId: z.string(),
        probability: z.number().min(0).max(1),
        explanation: z.record(z.string(), z.unknown()),
      }),
    )
    .max(10000),
});

@Injectable()
export class PredictiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly triggers: TriggersService,
  ) {}
  async policy(orgId: string) {
    return (
      (await this.prisma.churnPolicy.findUnique({ where: { orgId } })) ?? {
        threshold: 0.7,
        enabled: false,
        action: 'TASK',
      }
    );
  }
  async updatePolicy(u: AuthUser, dto: z.infer<typeof policyBody>, client: ClientInfo) {
    const p = await this.prisma.churnPolicy.upsert({
      where: { orgId: u.orgId },
      create: { orgId: u.orgId, ...dto },
      update: dto,
    });
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'predictive.policy.update',
      metadata: dto,
      client,
    });
    return p;
  }
  async list(orgId: string, q: z.infer<typeof pageQuery>) {
    const latest = await this.prisma.modelRun.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' } });
    if (!latest) return { items: [], total: 0, model: null, ...q };
    const where = { orgId, modelRunId: latest.id };
    const [items, total] = await Promise.all([
      this.prisma.prediction.findMany({
        where,
        orderBy: { churnProbability: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { customer: { select: { name: true, externalId: true } } },
      }),
      this.prisma.prediction.count({ where }),
    ]);
    return { items, total, model: latest, ...q };
  }
  async train(u: AuthUser, client: ClientInfo) {
    const transactions = await this.prisma.transaction.findMany({
      where: { orgId: u.orgId },
      select: { customerId: true, amount: true, occurredAt: true },
      take: 100001,
    });
    if (transactions.length > 100000)
      throw new BadRequestException('Máximo 100.000 transacciones por entrenamiento');
    const env = getEnv();
    let result: Record<string, unknown>;
    try {
      const response = await fetch(`${env.ML_SERVICE_URL}/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ML_SERVICE_TOKEN}` },
        body: JSON.stringify({
          orgId: u.orgId,
          asOf: new Date().toISOString(),
          transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
        }),
        signal: AbortSignal.timeout(90000),
        redirect: 'error',
      });
      if (response.status === 422) {
        const error = (await response.json()) as { detail?: string };
        throw new BadRequestException(error.detail ?? 'Historial insuficiente');
      }
      if (!response.ok) throw new Error('ML no disponible');
      result = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('No se pudo entrenar el modelo');
    }
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'predictive.train',
      client,
      metadata: { promoted: result.promoted, version: result.version ?? null },
    });
    return result;
  }
  async score(u: AuthUser, client: ClientInfo) {
    const rows = await this.analytics.rfm(u.orgId);
    if (!rows.length) throw new BadRequestException('Importa transacciones antes de generar predicciones');
    if (rows.length > 10000) throw new BadRequestException('Máximo 10.000 clientes por evaluación');
    const env = getEnv();
    let result: z.infer<typeof mlResponse>;
    try {
      const response = await fetch(`${env.ML_SERVICE_URL}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ML_SERVICE_TOKEN}` },
        body: JSON.stringify({
          orgId: u.orgId,
          customers: rows.map((r) => ({
            customerId: r.customerId,
            recencyDays: r.recencyDays,
            frequency: r.frequency,
            monetary: r.monetary,
          })),
        }),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`ML HTTP ${response.status}`);
      result = mlResponse.parse(await response.json());
      const expected = new Set(rows.map((r) => r.customerId));
      if (
        result.predictions.length !== rows.length ||
        new Set(result.predictions.map((p) => p.customerId)).size !== rows.length ||
        result.predictions.some((p) => !expected.has(p.customerId))
      )
        throw new Error('ML devolvió clientes inválidos');
    } catch {
      throw new ServiceUnavailableException('Servicio predictivo no disponible o respuesta inválida');
    }
    // Serializa scoring por organización y mantiene histórico sin duplicar tareas/alertas abiertas.
    const policy = await this.policy(u.orgId);
    const scored = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${u.orgId + ':score'}))`;
        const model = await tx.modelRun.create({
          data: {
            orgId: u.orgId,
            version: result.version,
            metrics: { ...result.metrics, mode: result.mode } as Prisma.InputJsonValue,
          },
        });
        await tx.prediction.createMany({
          data: result.predictions.map((p) => ({
            orgId: u.orgId,
            customerId: p.customerId,
            modelRunId: model.id,
            modelVersion: result.version,
            churnProbability: p.probability,
            riskBand: p.probability >= policy.threshold ? 'HIGH' : p.probability >= 0.4 ? 'MEDIUM' : 'LOW',
            explanation: p.explanation as Prisma.InputJsonValue,
          })),
        });
        const actions: Array<{ customerId: string; probability: number }> = [];
        // Un score heurístico es orientativo: nunca activa una política automática.
        if (policy.enabled && result.mode === 'trained')
          for (const p of result.predictions.filter((p) => p.probability >= policy.threshold)) {
            if (policy.action === 'TASK') {
              const exists = await tx.task.findFirst({
                where: {
                  orgId: u.orgId,
                  customerId: p.customerId,
                  source: 'predictive',
                  status: { not: 'DONE' },
                },
              });
              if (exists) continue;
              await tx.task.create({
                data: {
                  orgId: u.orgId,
                  customerId: p.customerId,
                  source: 'predictive',
                  title: 'Contactar cliente con riesgo de abandono',
                  description: `Probabilidad estimada: ${(p.probability * 100).toFixed(1)}%`,
                },
              });
            } else {
              const exists = await tx.alert.findFirst({
                where: {
                  orgId: u.orgId,
                  source: 'predictive',
                  status: { not: 'RESOLVED' },
                  metadata: { path: ['customerId'], equals: p.customerId },
                },
              });
              if (exists) continue;
              await tx.alert.create({
                data: {
                  orgId: u.orgId,
                  source: 'predictive',
                  severity: 'WARNING',
                  title: 'Riesgo de abandono',
                  message: `Probabilidad estimada: ${(p.probability * 100).toFixed(1)}%`,
                  metadata: { customerId: p.customerId, probability: p.probability },
                },
              });
            }
            actions.push({ customerId: p.customerId, probability: p.probability });
          }
        return { model, actions };
      },
      { timeout: 30000 },
    );
    let workflowsFired = 0;
    for (const action of scored.actions)
      workflowsFired += await this.triggers.fire(u.orgId, 'trigger.churn', action);
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'predictive.score',
      client,
      metadata: { customers: rows.length, mode: result.mode, actions: scored.actions.length, workflowsFired },
    });
    return { model: scored.model, customers: rows.length, actions: scored.actions.length, workflowsFired };
  }
}
@Controller('predictive')
class PredictiveController {
  constructor(private readonly predictive: PredictiveService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query(zod(pageQuery)) q: z.infer<typeof pageQuery>) {
    return this.predictive.list(u.orgId, q);
  }
  @Get('policy') policy(@CurrentUser() u: AuthUser) {
    return this.predictive.policy(u.orgId);
  }
  @Roles('ADMIN') @Put('policy') update(
    @CurrentUser() u: AuthUser,
    @Body(zod(policyBody)) dto: z.infer<typeof policyBody>,
    @Client() c: ClientInfo,
  ) {
    return this.predictive.updatePolicy(u, dto, c);
  }
  @Roles('ANALYST') @Throttle({ default: { limit: 3, ttl: 60000 } }) @Post('score') score(
    @CurrentUser() u: AuthUser,
    @Client() c: ClientInfo,
  ) {
    return this.predictive.score(u, c);
  }
  @Roles('ADMIN') @Throttle({ default: { limit: 2, ttl: 60000 } }) @Post('train') train(
    @CurrentUser() u: AuthUser,
    @Client() c: ClientInfo,
  ) {
    return this.predictive.train(u, c);
  }
}
@Module({ imports: [AnalyticsModule], controllers: [PredictiveController], providers: [PredictiveService] })
export class PredictiveModule {}
