import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
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
import {
  CancelledError,
  executeGraph,
  PermanentError,
  type EngineResult,
  type Executors,
  type StepResult,
} from './engine';
import { appendRunEvent } from './run-events';
import { redactDeep, redactText } from '../common/security/redact';
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
  async generate(
    orgId: string,
    title = 'Informe operativo',
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    if (idempotencyKey) {
      const existing = await this.prisma.alert.findUnique({ where: { idempotencyKey } });
      if (existing) return { ...((existing.metadata as Record<string, unknown>) ?? {}), deduplicated: true };
    }
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
        idempotencyKey,
      },
    });
    return summary;
  }
}

export const HTTP_CLIENT = Symbol('HTTP_CLIENT');
export type HttpClient = typeof safeFetch;

const HEARTBEAT_MS = 2_000;
const MAX_RESUMES = 3;
const RUN_DEADLINE_MS = 120_000;

@Injectable()
export class WorkflowRunner implements OnModuleInit {
  private readonly logger = new Logger('WorkflowRunner');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly reports: ReportsService,
    @Optional() @Inject(HTTP_CLIENT) private readonly httpClient: HttpClient = safeFetch,
  ) {}

  onModuleInit(): void {
    this.queue.setProcessor(
      (id) => this.process(id),
      async (id, err) => {
        const failed = await this.prisma.workflowRun.updateMany({
          where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
          data: {
            status: 'FAILED',
            error: `Error de infraestructura: ${err.message}`.slice(0, 500),
            finishedAt: new Date(),
          },
        });
        if (failed.count)
          await appendRunEvent(this.prisma, id, 'run.failed', { message: 'Error de infraestructura' });
      },
    );
  }

  /**
   * Ejecutores con efectos externos. Cada uno deduplica por `ctx.idempotencyKey` (runId:nodeId): un reintento
   * o una reanudación tras reinicio devuelve el efecto ya creado en lugar de repetirlo.
   */
  executorsFor(orgId: string, workflowId: string, runId: string): Executors {
    const allowlist = getEnv()
      .HTTP_ACTION_ALLOWLIST.split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const isDuplicate = (e: unknown) => (e as { code?: string }).code === 'P2002';
    return {
      notify: async (c, ctx) => {
        const key = ctx?.idempotencyKey;
        try {
          const a = await this.prisma.alert.create({
            data: {
              orgId,
              severity: c.severity as 'INFO' | 'WARNING' | 'CRITICAL',
              source: `workflow:${workflowId}`,
              title: c.title,
              message: c.message,
              metadata: { runId },
              idempotencyKey: key,
            },
          });
          return { alertId: a.id };
        } catch (e) {
          if (key && isDuplicate(e)) {
            const existing = await this.prisma.alert.findUnique({ where: { idempotencyKey: key } });
            return { alertId: existing?.id, deduplicated: true };
          }
          throw e;
        }
      },
      task: async (c, ctx) => {
        const key = ctx?.idempotencyKey;
        try {
          const t = await this.prisma.task.create({
            data: {
              orgId,
              title: c.title,
              description: c.description,
              source: `workflow:${workflowId}`,
              idempotencyKey: key,
            },
          });
          return { taskId: t.id };
        } catch (e) {
          if (key && isDuplicate(e)) {
            const existing = await this.prisma.task.findUnique({ where: { idempotencyKey: key } });
            return { taskId: existing?.id, deduplicated: true };
          }
          throw e;
        }
      },
      http: async (c, ctx) => {
        if (!allowlist.length)
          throw new PermanentError('Configura HTTP_ACTION_ALLOWLIST para habilitar acciones HTTP');
        let headers: Record<string, string> = { ...c.headers };
        const secrets = new Set<string>();
        if (c.integrationId) {
          // Aislamiento: la integración debe pertenecer a la organización del workflow.
          const integration = await this.prisma.integration.findFirst({
            where: { id: c.integrationId, orgId },
          });
          if (!integration || new URL(c.url).origin !== integration.baseUrl)
            throw new PermanentError('Integración inválida para este destino');
          const stored = JSON.parse(
            decryptSecret(integration.headersEnc, getEnv().DATA_ENCRYPTION_KEY, integration.id),
          ) as Record<string, string>;
          Object.values(stored).forEach((v) => secrets.add(v));
          headers = { ...headers, ...stored };
        }
        if (ctx?.idempotencyKey) headers['Idempotency-Key'] = ctx.idempotencyKey;
        let res;
        try {
          res = await this.httpClient(c.url, {
            allowlist,
            method: c.method as 'GET',
            headers,
            body: c.body,
            signal: ctx?.signal,
            timeoutMs: 10_000,
          });
        } catch (e) {
          throw new Error(redactText((e as Error).message, secrets));
        }
        if (res.status < 200 || res.status >= 300) {
          const message = `El servicio externo respondió HTTP ${res.status}`;
          // 4xx (salvo 408/429) no mejora al reintentar; 5xx y 429 sí son transitorios.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
            throw new PermanentError(message);
          throw new Error(message);
        }
        let json: unknown;
        if (res.body.length <= 8_000) {
          try {
            json = redactDeep(JSON.parse(res.body));
          } catch {
            json = undefined;
          }
        }
        return c.integrationId
          ? { status: res.status, truncated: res.truncated, json }
          : {
              status: res.status,
              truncated: res.truncated,
              bodyPreview: redactText(res.body.slice(0, 300), secrets),
              json,
            };
      },
      report: (c, ctx) => this.reports.generate(orgId, c.title, ctx?.idempotencyKey),
    };
  }

  /**
   * Ejecuta o reanuda una corrida. Cada paso se persiste al terminar (checkpoint), de modo que tras un reinicio
   * solo se re-ejecutan los pasos no completados. Los fallos de negocio quedan registrados; los de infraestructura
   * devuelven la corrida a la cola (hasta MAX_RESUMES) y se relanzan.
   */
  async process(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { workflow: true },
    });
    if (!run || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return;
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'QUEUED', attempts: run.attempts },
      data: {
        status: 'RUNNING',
        startedAt: run.startedAt ?? new Date(),
        heartbeatAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return;
    const fence = run.attempts + 1; // quien tenga esta generación es el único autorizado a escribir
    const started = Date.now();
    await appendRunEvent(this.prisma, runId, run.resumeCount > 0 ? 'run.resumed' : 'run.started', {
      data: { attempt: fence, resumeCount: run.resumeCount },
    });

    const abort = new AbortController();
    let lost = false;
    const tick = setInterval(() => {
      void (async () => {
        try {
          const beat = await this.prisma.workflowRun.updateMany({
            where: { id: runId, status: 'RUNNING', attempts: fence },
            data: { heartbeatAt: new Date() },
          });
          if (!beat.count) {
            lost = true; // otra instancia reanudó la corrida o fue cancelada: dejar de escribir
            abort.abort();
            return;
          }
          const cur = await this.prisma.workflowRun.findUnique({
            where: { id: runId },
            select: { cancelRequestedAt: true },
          });
          if (cur?.cancelRequestedAt) abort.abort();
        } catch {
          /* el siguiente latido reintenta */
        }
      })();
    }, HEARTBEAT_MS);
    tick.unref?.();

    try {
      const validation = validateGraph(run.graphSnapshot ?? run.workflow.graph);
      let result: EngineResult;
      if (!validation.ok) {
        result = { status: 'FAILED', steps: [], error: `Grafo inválido: ${validation.errors[0]}` };
      } else {
        const done = await this.prisma.workflowRunStep.findMany({ where: { runId, status: 'SUCCEEDED' } });
        const completed = new Map<string, StepResult>(
          done.map((s) => [
            s.nodeId,
            {
              nodeId: s.nodeId,
              nodeType: s.nodeType,
              status: 'SUCCEEDED',
              // El trigger se reconstruye desde el payload original (la salida persistida está enmascarada).
              output: s.nodeType.startsWith('trigger.')
                ? { payload: run.triggerPayload }
                : (s.output ?? undefined),
              durationMs: s.durationMs,
              attempts: s.attempts,
            },
          ]),
        );
        // Vallado: la escritura solo procede si esta generación sigue siendo la dueña (fila bloqueada hasta el commit).
        const fenced = async (write: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          if (lost) throw new CancelledError();
          const ok = await this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "WorkflowRun" WHERE "id" = ${runId} AND "status" = 'RUNNING' AND "attempts" = ${fence} FOR UPDATE`;
            if (rows.length === 0) return false;
            await write(tx);
            return true;
          });
          if (!ok) {
            lost = true;
            abort.abort();
            throw new CancelledError();
          }
        };
        result = await executeGraph(
          validation.graph as WorkflowGraph,
          run.triggerPayload,
          this.executorsFor(run.orgId, run.workflowId, runId),
          { runId, deadlineMs: RUN_DEADLINE_MS },
          {
            completed,
            signal: abort.signal,
            isCancelled: async () =>
              lost ||
              !!(
                await this.prisma.workflowRun.findUnique({
                  where: { id: runId },
                  select: { cancelRequestedAt: true },
                })
              )?.cancelRequestedAt,
            onStepStart: async (node, attempt) => {
              await fenced((tx) =>
                tx.workflowRunStep.upsert({
                  where: { runId_nodeId: { runId, nodeId: node.id } },
                  create: {
                    runId,
                    nodeId: node.id,
                    nodeType: node.type,
                    status: 'RUNNING',
                    attempts: attempt,
                    startedAt: new Date(),
                    idempotencyKey: `${runId}:${node.id}`,
                  },
                  update: { status: 'RUNNING', attempts: attempt, startedAt: new Date(), error: null },
                }),
              );
              if (attempt === 1)
                await appendRunEvent(this.prisma, runId, 'step.started', { nodeId: node.id });
            },
            onRetry: async (node, attempt, error, delayMs) => {
              await appendRunEvent(this.prisma, runId, 'step.retry', {
                nodeId: node.id,
                message: error,
                data: { attempt, nextDelayMs: delayMs },
              });
            },
            onStepEnd: async (step) => {
              const output =
                step.output === undefined ? undefined : (redactDeep(step.output) as Prisma.InputJsonValue);
              await fenced((tx) =>
                tx.workflowRunStep.upsert({
                  where: { runId_nodeId: { runId, nodeId: step.nodeId } },
                  create: {
                    runId,
                    nodeId: step.nodeId,
                    nodeType: step.nodeType,
                    status: step.status,
                    attempts: step.attempts ?? 1,
                  },
                  update: {
                    status: step.status,
                    output,
                    error: step.error ?? null,
                    attempts: step.attempts ?? 1,
                    durationMs: step.durationMs,
                    finishedAt: new Date(),
                  },
                }),
              );
              await appendRunEvent(
                this.prisma,
                runId,
                step.status === 'SUCCEEDED'
                  ? 'step.succeeded'
                  : step.status === 'CANCELLED'
                    ? 'step.cancelled'
                    : 'step.failed',
                {
                  nodeId: step.nodeId,
                  message: step.error,
                  data: { durationMs: step.durationMs, attempts: step.attempts },
                },
              );
            },
          },
        );
      }
      if (lost) return; // otra generación es dueña de la corrida
      const final = await this.prisma.workflowRun.updateMany({
        where: { id: runId, status: 'RUNNING', attempts: fence },
        data: {
          status: result.status,
          error: result.error ?? null,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
        },
      });
      if (final.count)
        await appendRunEvent(
          this.prisma,
          runId,
          result.status === 'SUCCEEDED'
            ? 'run.succeeded'
            : result.status === 'CANCELLED'
              ? 'run.cancelled'
              : 'run.failed',
          { message: result.error },
        );
    } catch (err) {
      if (lost) return;
      this.logger.error(`Run ${runId}: ${(err as Error).message}`);
      const requeued = await this.prisma.workflowRun
        .updateMany({
          where: { id: runId, status: 'RUNNING', attempts: fence, resumeCount: { lt: MAX_RESUMES } },
          data: { status: 'QUEUED', resumeCount: { increment: 1 } },
        })
        .catch(() => ({ count: 0 }));
      if (requeued.count)
        await appendRunEvent(this.prisma, runId, 'run.requeued', {
          message: 'Error de infraestructura',
        }).catch(() => undefined);
      else
        await this.prisma.workflowRun
          .updateMany({
            where: { id: runId, status: 'RUNNING', attempts: fence },
            data: { status: 'FAILED', error: 'Error de infraestructura repetido', finishedAt: new Date() },
          })
          .catch(() => undefined);
      throw err;
    } finally {
      clearInterval(tick);
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
    const runId = await this.triggers.dispatch(w, 'manual', payload, undefined, user.id);
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
          triggeredBy: true,
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
    const events = await this.prisma.workflowRunEvent.findMany({
      where: { runId: id },
      orderBy: { seq: 'asc' },
      take: 500,
      select: { seq: true, type: true, nodeId: true, message: true, data: true, createdAt: true },
    });
    // El payload original se conserva para poder reanudar, pero nunca se devuelve con claves sensibles.
    return { ...run, triggerPayload: redactDeep(run.triggerPayload), events };
  }

  /** Solicita la cancelación. Si aún no empezó se cancela al instante; si corre, se aborta cooperativamente. */
  async cancelRun(user: AuthUser, id: string, client: ClientInfo) {
    const run = await this.prisma.workflowRun.findFirst({ where: { id, orgId: user.orgId } });
    if (!run) throw new NotFoundException('Ejecución no encontrada');
    if (!['QUEUED', 'RUNNING'].includes(run.status))
      throw new BadRequestException(`La ejecución ya terminó (${run.status})`);
    const now = new Date();
    const direct = await this.prisma.workflowRun.updateMany({
      where: { id, orgId: user.orgId, status: 'QUEUED' },
      data: {
        status: 'CANCELLED',
        cancelRequestedAt: now,
        cancelledBy: user.id,
        finishedAt: now,
        error: 'Cancelada por el usuario',
      },
    });
    if (direct.count)
      await appendRunEvent(this.prisma, id, 'run.cancelled', {
        message: 'Cancelada antes de iniciar',
        data: { by: user.id },
      });
    else {
      await this.prisma.workflowRun.updateMany({
        where: { id, orgId: user.orgId, status: 'RUNNING' },
        data: { cancelRequestedAt: now, cancelledBy: user.id },
      });
      await appendRunEvent(this.prisma, id, 'run.cancel_requested', { data: { by: user.id } });
    }
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'workflow.run_cancel',
      resource: 'workflow_run',
      resourceId: id,
      client,
    });
    return { id, status: direct.count ? 'CANCELLED' : 'CANCELLING' };
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
