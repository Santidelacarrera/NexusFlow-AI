ALTER TABLE "Organization" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Prediction" ADD COLUMN "modelRunId" TEXT;
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Prediction_orgId_modelRunId_idx" ON "Prediction"("orgId", "modelRunId");
ALTER TABLE "WorkflowRun" ADD COLUMN "graphSnapshot" JSONB;
ALTER TABLE "WorkflowRun" ADD COLUMN "dispatchKey" TEXT;
CREATE UNIQUE INDEX "WorkflowRun_dispatchKey_key" ON "WorkflowRun"("dispatchKey");
ALTER TABLE "Alert" ADD COLUMN "dedupKey" TEXT;
CREATE UNIQUE INDEX "Alert_dedupKey_key" ON "Alert"("dedupKey");
