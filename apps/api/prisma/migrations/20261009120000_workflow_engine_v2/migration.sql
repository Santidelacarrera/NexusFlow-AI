ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "StepStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE "StepStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "WorkflowRun"
  ADD COLUMN "resumeCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "triggeredBy" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledBy" TEXT,
  ADD COLUMN "heartbeatAt" TIMESTAMP(3);
CREATE INDEX "WorkflowRun_status_heartbeatAt_idx" ON "WorkflowRun"("status", "heartbeatAt");

ALTER TABLE "WorkflowRunStep"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "idempotencyKey" TEXT,
  ALTER COLUMN "durationMs" SET DEFAULT 0;
-- Pasos históricos: una fila por nodo y ejecución antes de exigir unicidad.
DELETE FROM "WorkflowRunStep" a USING "WorkflowRunStep" b
  WHERE a."runId" = b."runId" AND a."nodeId" = b."nodeId" AND a."id" < b."id";
CREATE UNIQUE INDEX "WorkflowRunStep_runId_nodeId_key" ON "WorkflowRunStep"("runId", "nodeId");

CREATE TABLE "WorkflowRunEvent" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "nodeId" TEXT,
  "message" TEXT,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowRunEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowRunEvent_runId_seq_key" ON "WorkflowRunEvent"("runId", "seq");
ALTER TABLE "WorkflowRunEvent" ADD CONSTRAINT "WorkflowRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Alert" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Alert_idempotencyKey_key" ON "Alert"("idempotencyKey");
ALTER TABLE "Task" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Task_idempotencyKey_key" ON "Task"("idempotencyKey");
