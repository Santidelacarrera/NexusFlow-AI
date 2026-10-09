import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { redactDeep } from '../common/security/redact';

export type RunEventType =
  | 'run.queued'
  | 'run.started'
  | 'run.resumed'
  | 'run.requeued'
  | 'run.cancel_requested'
  | 'run.cancelled'
  | 'run.succeeded'
  | 'run.failed'
  | 'step.started'
  | 'step.retry'
  | 'step.succeeded'
  | 'step.failed'
  | 'step.cancelled';

/** Añade un evento a la traza de la ejecución con número de secuencia monótono (índice único + reintento). */
export async function appendRunEvent(
  prisma: Pick<PrismaService, '$executeRaw'>,
  runId: string,
  type: RunEventType,
  extra: { nodeId?: string; message?: string; data?: unknown } = {},
): Promise<void> {
  const data = extra.data === undefined ? null : JSON.stringify(redactDeep(extra.data));
  for (let i = 0; i < 5; i++) {
    try {
      await prisma.$executeRaw`
        INSERT INTO "WorkflowRunEvent" ("id", "runId", "seq", "type", "nodeId", "message", "data")
        SELECT ${randomUUID()}, ${runId}, COALESCE(MAX("seq"), 0) + 1, ${type}, ${extra.nodeId ?? null},
               ${extra.message?.slice(0, 500) ?? null}, ${data}::jsonb
        FROM "WorkflowRunEvent" WHERE "runId" = ${runId}`;
      return;
    } catch (err) {
      const code =
        (err as { code?: string; meta?: { code?: string } }).meta?.code ?? (err as { code?: string }).code;
      if (code !== '23505' && code !== 'P2010' && code !== 'P2002') throw err;
    }
  }
}

export type { Prisma };
