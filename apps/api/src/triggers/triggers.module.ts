import {
  BadRequestException,
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { Queue, Worker } from 'bullmq';
import { getEnv } from '../common/config/env';
import { PrismaService } from '../prisma/prisma.service';

export type RunProcessor = (runId: string) => Promise<void>;

const QUEUE_NAME = 'workflow-runs';
const MAX_ACTIVE_RUNS_PER_ORG = 200;
const MAX_PAYLOAD_BYTES = 50_000;

function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null as null,
  };
}

/**
 * Cola de ejecuciones. Con REDIS_URL usa BullMQ (persistente, reintentos con backoff exponencial, concurrencia).
 * Sin Redis ejecuta en proceso (útil en desarrollo y tests) y recupera ejecuciones pendientes al arrancar.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Queue');
  private queue?: Queue;
  private worker?: Worker;
  private processor?: RunProcessor;
  private onFinalFailure?: (runId: string, err: Error) => Promise<void>;
  private pending = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  setProcessor(processor: RunProcessor, onFinalFailure: (runId: string, err: Error) => Promise<void>): void {
    this.processor = processor;
    this.onFinalFailure = onFinalFailure;
    if (getEnv().REDIS_URL && !this.worker) this.startWorker();
  }

  async onModuleInit(): Promise<void> {
    const url = getEnv().REDIS_URL;
    if (url) {
      this.queue = new Queue(QUEUE_NAME, {
        connection: redisConnection(url),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      });
      this.queue.on('error', (e) => this.logger.error(`Redis (cola): ${e.message}`));
      this.logger.log('Cola BullMQ activa');
    } else {
      this.logger.warn('REDIS_URL no definido: ejecución en proceso (sin persistencia de cola)');
      const stuck = await this.prisma.workflowRun.findMany({
        where: { status: 'QUEUED' },
        select: { id: true },
        take: 500,
      });
      stuck.forEach((r) => this.enqueue(r.id));
    }
  }

  private startWorker(): void {
    this.worker = new Worker(QUEUE_NAME, async (job) => this.processor?.(job.data.runId as string), {
      connection: redisConnection(getEnv().REDIS_URL as string),
      concurrency: 5,
    });
    this.worker.on('error', (e) => this.logger.error(`Redis (worker): ${e.message}`));
    this.worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
        void this.onFinalFailure?.(job.data.runId as string, err);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  enqueue(runId: string): void {
    if (this.queue) {
      this.queue
        .add('run', { runId }, { jobId: runId })
        .catch((e) => this.logger.error(`No se pudo encolar ${runId}: ${e.message}`));
      return;
    }
    if (this.pending.has(runId)) return;
    this.pending.add(runId);
    setImmediate(() => {
      this.processor?.(runId)
        .catch((e) => {
          this.logger.error(`Ejecución ${runId} falló: ${e.message}`);
          void this.onFinalFailure?.(runId, e);
        })
        .finally(() => this.pending.delete(runId));
    });
  }

  @Cron('*/30 * * * * *')
  async recover(): Promise<void> {
    // La BD actúa como outbox: un fallo de Redis no pierde la ejecución creada.
    const queued = await this.prisma.workflowRun.findMany({
      where: { status: 'QUEUED', createdAt: { lt: new Date(Date.now() - 10000) } },
      select: { id: true },
      take: 200,
    });
    queued.forEach((r) => this.enqueue(r.id));
    // No repetir efectos externos de corridas interrumpidas: requieren revisión manual.
    await this.prisma.workflowRun.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 300000) } },
      data: {
        status: 'FAILED',
        error: 'Ejecución interrumpida; revisar efectos antes de volver a ejecutar',
        finishedAt: new Date(),
      },
    });
  }
}

@Injectable()
export class TriggersService {
  private readonly logger = new Logger('Triggers');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Crea la ejecución (QUEUED) y la encola. Aplica cuota por organización y límite de tamaño del payload. */
  async dispatch(
    workflow: { id: string; orgId: string },
    triggerType: string,
    payload: unknown,
    dispatchKey?: string,
  ): Promise<string | null> {
    const json = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES)
      throw new BadRequestException('Payload demasiado grande');
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workflow.orgId + ':dispatch'}))`;
      if (dispatchKey && (await tx.workflowRun.findUnique({ where: { dispatchKey }, select: { id: true } })))
        return null;
      const active = await tx.workflowRun.count({
        where: { orgId: workflow.orgId, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (active >= MAX_ACTIVE_RUNS_PER_ORG) {
        this.logger.warn(`Cuota de ejecuciones activas alcanzada para org ${workflow.orgId}`);
        return null;
      }
      const wf = await tx.workflow.findFirst({
        where: { id: workflow.id, orgId: workflow.orgId },
        select: { graph: true },
      });
      if (!wf) return null;
      return tx.workflowRun.create({
        data: {
          workflowId: workflow.id,
          orgId: workflow.orgId,
          triggerType,
          triggerPayload: JSON.parse(json) as Prisma.InputJsonValue,
          graphSnapshot: wf.graph as Prisma.InputJsonValue,
          dispatchKey,
        },
        select: { id: true },
      });
    });
    if (!run) return null;
    this.queue.enqueue(run.id);
    return run.id;
  }

  /** Dispara todos los workflows ACTIVOS de la organización cuyo trigger coincide con el evento. */
  async fire(orgId: string, triggerType: string, payload: unknown): Promise<number> {
    const workflows = await this.prisma.workflow.findMany({
      where: { orgId, status: 'ACTIVE', triggerType },
      select: { id: true, orgId: true },
      take: 20,
    });
    let fired = 0;
    for (const wf of workflows) {
      if (triggerType === 'trigger.churn') {
        const graph = await this.prisma.workflow.findUnique({
          where: { id: wf.id },
          select: { graph: true },
        });
        const nodes = (
          graph?.graph as unknown as { nodes?: Array<{ type: string; data: { minProbability?: number } }> }
        )?.nodes;
        const minimum = nodes?.find((n) => n.type === triggerType)?.data.minProbability ?? 0;
        if (Number((payload as { probability?: number })?.probability ?? 0) < minimum) continue;
      }
      if (await this.dispatch(wf, triggerType, payload)) fired++;
    }
    return fired;
  }
}

@Global()
@Module({ providers: [QueueService, TriggersService], exports: [QueueService, TriggersService] })
export class TriggersModule {}
