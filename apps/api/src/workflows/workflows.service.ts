import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.module';
import { AuditService } from '../audit/audit.service';
import { getEnv } from '../common/config/env';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { decryptSecret, encryptSecret, randomToken } from '../common/security/crypto';
import { safeFetch } from '../common/security/ssrf';
import { OperationsService } from '../operations/operations.module';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService, TriggersService } from '../triggers/triggers.module';
import { cronMatches, isValidCron } from './cron';
import { executeGraph, type Executors } from './engine';
import { validateGraph, type WorkflowGraph } from './graph';

export const workflowInput = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  graph: z.unknown(),
});
export type WorkflowInput = z.infer<typeof workflowInput>;

const MINUTES_SAVED_PER_ACTION = 5;

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly ops: OperationsService,
  ) {}

  /** Informe consolidado (comercial + operativo + calidad de datos). Se guarda como alerta informativa. */
  async generate(orgId: string, title = 'Informe operativo'): Promise<Record<string, unknown>> {
    const [overview, ops, lastImport, openAlerts] = await Promise.all([
      this.analytics.overview(orgId),
      this.ops.kpis(orgId),
      this.prisma.importJob.findFirst({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, totalRows: true, rejectedRows: true, createdAt: true },
      }),
      this.prisma.alert.count({ where: { orgId, status: 'OPEN' } }),
    ]);
    const summary = {
      generatedAt: new Date().toISOString(),
      commercial: {
        revenue: overview.revenue,
        orders: overview.orders,
        avgTicket: overview.avgTicket,
        repeatRate: overview.repeatRate,
      },
      operations: { total: ops.total, late: ops.late, onTimeRate: ops.onTimeRate },
      dataQuality: lastImport
        ? {
            lastImportStatus: lastImport.status,
            rejectedRows: lastImport.rejectedRows,
            totalRows: lastImport.totalRows,
          }
        : null,
      openAlerts,
    };
    await this.prisma.alert.create({
      data: {
        orgId,
        severity: 'INFO',
        source: 'autoops',
        title,
        message: `Ingresos ${summary.commercial.revenue}, pedidos ${summary.commercial.orders}, entregas a tiempo ${summary.operations.onTimeRate ?? 'n/d'}%, alertas abiertas ${openAlerts}.`,
        metadata: summary as Prisma.InputJsonValue,
      },
    });
    return summary;
  }
}

@Injectable()
export class WorkflowRunner implements OnModuleInit {
  private readonly logger = new Logger('WorkflowRunner');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly reports: ReportsService,
  ) {}

  onModuleInit(): void {
    this.queue.setProcessor(
      (id) => this.process(id),
      async (id, err) => {
        await this.prisma.workflowRun.updateMany({
          where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
          data: {
            status: 'FAILED',
            error: `Error de infraestructura: ${err.message}`.slice(0, 500),
            finishedAt: new Date(),
          },
        });
      },
    );
  }

  executorsFor(orgId: string, workflowId: string, runId: string): Executors {
    const allowlist = getEnv()
      .HTTP_ACTION_ALLOWLIST.split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return {
      notify: async (c) => {
        const a = await this.prisma.alert.create({
          data: {
            orgId,
            severity: c.severity as 'INFO' | 'WARNING' | 'CRITICAL',
            source: `workflow:${workflowId}`,
            title: c.title,
            message: c.message,
            metadata: { runId },
          },
        });
        return { alertId: a.id };
      },
      task: async (c) => {
        const t = await this.prisma.task.create({
          data: { orgId, title: c.title, description: c.description, source: `workflow:${workflowId}` },
        });
        return { taskId: t.id };
      },
      http: async (c) => {
        if (!allowlist.length)
          throw new Error('Configura HTTP_ACTION_ALLOWLIST para habilitar acciones HTTP');
        let headers = c.headers;
        if (c.integrationId) {
          const integration = await this.prisma.integration.findFirst({
            where: { id: c.integrationId, orgId },
          });
          if (!integration || new URL(c.url).origin !== integration.baseUrl)
            throw new Error('Integración inválida para este destino');
          headers = {
            ...headers,
            ...(JSON.parse(
              decryptSecret(integration.headersEnc, getEnv().DATA_ENCRYPTION_KEY, integration.id),
            ) as Record<string, string>),
          };
        }
        const res = await safeFetch(c.url, { allowlist, method: c.method as 'GET', headers, body: c.body });
        if (res.status < 200 || res.status >= 300)
          throw new Error(`El servicio externo respondió HTTP ${res.status}`);
        return c.integrationId
          ? { status: res.status, truncated: res.truncated }
          : { status: res.status, bodyPreview: res.body.slice(0, 300) };
      },
      report: (c) => this.reports.generate(orgId, c.title),
    };
  }

  /** Ejecuta una corrida. Los fallos de negocio quedan registrados; solo los de infraestructura se relanzan para reintento. */
  async process(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { workflow: true },
    });
    if (!run || run.status === 'SUCCEEDED' || run.status === 'FAILED') return;
    const started = Date.now();
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;

    try {
      const validation = validateGraph(run.graphSnapshot ?? run.workflow.graph);
      const result = validation.ok
        ? await executeGraph(
            validation.graph as WorkflowGraph,
            run.triggerPayload,
            this.executorsFor(run.orgId, run.workflowId, runId),
          )
        : { status: 'FAILED' as const, steps: [], error: `Grafo inválido: ${validation.errors[0]}` };

      await this.prisma.$transaction([
        this.prisma.workflowRunStep.deleteMany({ where: { runId } }),
        this.prisma.workflowRunStep.createMany({
          data: result.steps.map((s) => ({
            runId,
            nodeId: s.nodeId,
            nodeType: s.nodeType,
            status: s.status,
            durationMs: s.durationMs,
            error: s.error,
            output: s.output === undefined ? undefined : (s.output as Prisma.InputJsonValue),
          })),
        }),
        this.prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: result.status,
            error: result.error,
            finishedAt: new Date(),
            durationMs: Date.now() - started,
          },
        }),
      ]);
    } catch (err) {
      this.logger.error(`Run ${runId}: ${(err as Error).message}`);
      await this.prisma.workflowRun
        .update({
          where: { id: runId },
          data: {
            status: 'FAILED',
            error: 'Error de persistencia; revisar efectos antes de reejecutar',
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw err;
    }
  }
}

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly triggers: TriggersService,
  ) {}

  private view(w: { webhookId: string | null; webhookSecretEnc?: string | null; [k: string]: unknown }) {
    const { webhookSecretEnc: _omit, ...rest } = w;
    return { ...rest, webhookPath: w.webhookId ? `/api/hooks/${w.webhookId}` : null };
  }

  private parse(input: WorkflowInput) {
    const v = validateGraph(input.graph);
    if (!v.ok || !v.graph || !v.triggerType)
      throw new BadRequestException({
        message: 'Workflow inválido',
        issues: v.errors.slice(0, 20).map((m) => ({ message: m })),
      });
    let cron: string | null = null;
    if (v.triggerType === 'trigger.schedule') {
      const node = v.graph.nodes.find((n) => n.type === 'trigger.schedule');
      cron = String(node?.data.cron ?? '');
      if (!isValidCron(cron))
        throw new BadRequestException('Expresión cron inválida (formato: min hora día mes díaSemana)');
    }
    return { graph: v.graph, triggerType: v.triggerType, cron };
  }

  async list(orgId: string) {
    const items = await this.prisma.workflow.findMany({
      where: { orgId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return items.map((w) => this.view(w));
  }

  async get(orgId: string, id: string) {
    const w = await this.prisma.workflow.findFirst({ where: { id, orgId } });
    if (!w) throw new NotFoundException('Workflow no encontrado');
    return this.view(w);
  }

  async create(user: AuthUser, input: WorkflowInput, client: ClientInfo) {
    const p = this.parse(input);
    const count = await this.prisma.workflow.count({ where: { orgId: user.orgId } });
    if (count >= 100) throw new BadRequestException('Se alcanzó el máximo de 100 workflows por organización');
    let wf = await this.prisma.workflow.create({
      data: {
        orgId: user.orgId,
        name: input.name,
        description: input.description,
        graph: p.graph as unknown as Prisma.InputJsonValue,
        triggerType: p.triggerType,
        cron: p.cron,
        createdBy: user.id,
        webhookId: p.triggerType === 'trigger.webhook' ? randomToken(18) : null,
      },
    });
    let secret: string | undefined;
    if (wf.webhookId) {
      secret = randomToken(32);
      wf = await this.prisma.workflow.update({
        where: { id: wf.id },
        data: { webhookSecretEnc: encryptSecret(secret, getEnv().DATA_ENCRYPTION_KEY, wf.id) },
      });
    }
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'workflow.create',
      resource: 'workflow',
      resourceId: wf.id,
      client,
      metadata: { name: wf.name },
    });
    return { ...this.view(wf), webhookSecret: secret };
  }

  async update(user: AuthUser, id: string, input: WorkflowInput, client: ClientInfo) {
    const existing = await this.prisma.workflow.findFirst({ where: { id, orgId: user.orgId } });
    if (!existing) throw new NotFoundException('Workflow no encontrado');
    const p = this.parse(input);
    const needsHook = p.triggerType === 'trigger.webhook' && !existing.webhookId;
    const secret = needsHook ? randomToken(32) : undefined;
    const wf = await this.prisma.workflow.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        graph: p.graph as unknown as Prisma.InputJsonValue,
        triggerType: p.triggerType,
        cron: p.cron,
        version: { increment: 1 },
        ...(needsHook
          ? {
              webhookId: randomToken(18),
              webhookSecretEnc: encryptSecret(secret as string, getEnv().DATA_ENCRYPTION_KEY, id),
            }
          : {}),
        ...(p.triggerType !== 'trigger.webhook' ? { webhookId: null, webhookSecretEnc: null } : {}),
      },
    });
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'workflow.update',
      resource: 'workflow',
      resourceId: id,
      client,
      metadata: { version: wf.version },
    });
    return { ...this.view(wf), webhookSecret: secret };
  }

  async setStatus(user: AuthUser, id: string, status: 'ACTIVE' | 'PAUSED', client: ClientInfo) {
    const w = await this.prisma.workflow.findFirst({ where: { id, orgId: user.orgId } });
    if (!w) throw new NotFoundException('Workflow no encontrado');
    if (status === 'ACTIVE' && !validateGraph(w.graph).ok)
      throw new BadRequestException('No se puede activar un workflow inválido');
    const updated = await this.prisma.workflow.update({ where: { id }, data: { status } });
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: `workflow.${status.toLowerCase()}`,
      resource: 'workflow',
      resourceId: id,
      client,
    });
    return this.view(updated);
  }

  async remove(user: AuthUser, id: string, client: ClientInfo) {
    const res = await this.prisma.workflow.deleteMany({ where: { id, orgId: user.orgId } });
    if (res.count === 0) throw new NotFoundException('Workflow no encontrado');
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'workflow.delete',
      resource: 'workflow',
      resourceId: id,
      client,
    });
  }

  async rotateSecret(user: AuthUser, id: string, client: ClientInfo) {
    const w = await this.prisma.workflow.findFirst({ where: { id, orgId: user.orgId } });
    if (!w) throw new NotFoundException('Workflow no encontrado');
    if (!w.webhookId) throw new BadRequestException('El workflow no usa trigger webhook');
    const secret = randomToken(32);
    await this.prisma.workflow.update({
      where: { id },
      data: { webhookSecretEnc: encryptSecret(secret, getEnv().DATA_ENCRYPTION_KEY, id) },
    });
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'workflow.secret_rotated',
      resource: 'workflow',
      resourceId: id,
      client,
    });
    return { webhookPath: `/api/hooks/${w.webhookId}`, webhookSecret: secret };
  }

  async runManual(user: AuthUser, id: string, payload: unknown, client: ClientInfo) {
    const w = await this.prisma.workflow.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, orgId: true },
    });
    if (!w) throw new NotFoundException('Workflow no encontrado');
    const runId = await this.triggers.dispatch(w, 'manual', payload);
    if (!runId)
      throw new BadRequestException('Demasiadas ejecuciones en curso, intenta de nuevo en unos instantes');
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'workflow.run',
      resource: 'workflow',
      resourceId: id,
      client,
      metadata: { runId },
    });
    return { runId };
  }

  async listRuns(orgId: string, page: number, pageSize: number, workflowId?: string) {
    const where: Prisma.WorkflowRunWhereInput = { orgId, ...(workflowId ? { workflowId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.workflowRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          workflowId: true,
          status: true,
          triggerType: true,
          attempts: true,
          error: true,
          durationMs: true,
          createdAt: true,
          finishedAt: true,
          workflow: { select: { name: true } },
        },
      }),
      this.prisma.workflowRun.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getRun(orgId: string, id: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id, orgId },
      include: { steps: { orderBy: { createdAt: 'asc' } }, workflow: { select: { name: true } } },
    });
    if (!run) throw new NotFoundException('Ejecución no encontrada');
    return run;
  }

  async stats(orgId: string) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [byStatus, avg, actions] = await Promise.all([
      this.prisma.workflowRun.groupBy({
        by: ['status'],
        where: { orgId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.workflowRun.aggregate({
        where: { orgId, status: 'SUCCEEDED', createdAt: { gte: since } },
        _avg: { durationMs: true },
      }),
      this.prisma.workflowRunStep.count({
        where: {
          run: { orgId, createdAt: { gte: since } },
          status: 'SUCCEEDED',
          nodeType: { startsWith: 'action.' },
        },
      }),
    ]);
    const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const finished = count('SUCCEEDED') + count('FAILED');
    return {
      windowDays: 30,
      runs: byStatus.reduce((a, b) => a + b._count._all, 0),
      succeeded: count('SUCCEEDED'),
      failed: count('FAILED'),
      successRate: finished ? Math.round((count('SUCCEEDED') / finished) * 1000) / 10 : null,
      avgDurationMs: avg._avg.durationMs ? Math.round(avg._avg.durationMs) : null,
      automatedActions: actions,
      estimatedMinutesSaved: actions * MINUTES_SAVED_PER_ACTION,
    };
  }

  /** Verifica y descifra el secreto del webhook para validar la firma HMAC (nunca se devuelve al cliente). */
  async webhookTarget(webhookId: string) {
    const wf = await this.prisma.workflow.findUnique({ where: { webhookId } });
    if (!wf || wf.status !== 'ACTIVE' || !wf.webhookSecretEnc) return null;
    return {
      workflow: { id: wf.id, orgId: wf.orgId },
      secret: decryptSecret(wf.webhookSecretEnc, getEnv().DATA_ENCRYPTION_KEY, wf.id),
    };
  }

  /** Scheduler: cada minuto evalúa los workflows con trigger programado (idempotente por minuto). */
  @Cron('* * * * *')
  async tick(): Promise<void> {
    const now = new Date();
    const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const due = await this.prisma.workflow.findMany({
      where: { status: 'ACTIVE', triggerType: 'trigger.schedule', cron: { not: null } },
      select: { id: true, orgId: true, cron: true },
      take: 1000,
    });
    for (const w of due) {
      if (!w.cron || !cronMatches(w.cron, minuteStart)) continue;
      const already = await this.prisma.workflowRun.findFirst({
        where: { workflowId: w.id, triggerType: 'schedule', createdAt: { gte: minuteStart } },
        select: { id: true },
      });
      if (!already)
        await this.triggers.dispatch(
          w,
          'schedule',
          { scheduledFor: minuteStart.toISOString() },
          `schedule:${w.id}:${minuteStart.toISOString()}`,
        );
    }
  }
}
