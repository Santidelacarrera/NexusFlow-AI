/**
 * Pruebas de integración del motor contra PostgreSQL real. Se activan con RUN_DB_TESTS=1 y DATABASE_URL
 * apuntando a una base con las migraciones aplicadas (en CI: servicio postgres).
 */
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined, ScheduleModule: {} }));
// Cola en proceso: en CI `npm run setup` copia .env.example con un REDIS_URL que no existe en el runner.
process.env.REDIS_URL = '';
import { PermanentError, type Executors } from './engine';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService, TriggersService } from '../triggers/triggers.module';
import { ReportsService, WorkflowRunner, WorkflowsService } from './workflows.service';
import type { AuthUser } from '../common/http/types';
import type { WorkflowGraph } from './graph';

const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

class TestRunner extends WorkflowRunner {
  overrides = new Map<string, Partial<Executors>>();
  override executorsFor(orgId: string, workflowId: string, runId: string): Executors {
    return {
      ...super.executorsFor(orgId, workflowId, runId),
      ...(this.overrides.get('x') ?? {}),
    } as Executors;
  }
}

d('motor de workflows sobre PostgreSQL', () => {
  const prisma = new PrismaService();
  let queue: QueueService;
  let triggers: TriggersService;
  let orgId: string;
  let otherOrgId: string;
  let user: AuthUser;
  const audit = { record: async () => undefined } as never;

  const graph = (extra: Partial<WorkflowGraph> = {}): WorkflowGraph => ({
    nodes: [
      { id: 't', type: 'trigger.manual', data: {} },
      { id: 'task', type: 'action.task', data: { title: 'Revisar {{trigger.id}}' } },
      {
        id: 'http',
        type: 'action.http',
        data: { url: 'https://api.example.com/x', method: 'POST', retries: 2 },
      },
      { id: 'done', type: 'action.notify', data: { severity: 'INFO', title: 'ok', message: 'listo' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'task' },
      { id: 'e2', source: 'task', target: 'http' },
      { id: 'e3', source: 'http', target: 'done' },
    ],
    ...extra,
  });

  async function makeRun(g: WorkflowGraph, payload: unknown = { id: 'A1' }) {
    const wf = await prisma.workflow.create({
      data: {
        orgId,
        name: 'wf',
        graph: g as never,
        triggerType: g.nodes[0].type,
        createdBy: user.id,
        status: 'ACTIVE',
      },
    });
    const runId = await triggers.dispatch({ id: wf.id, orgId }, 'manual', payload, undefined, user.id);
    return { wf, runId: runId as string };
  }
  function runner(http: Executors['http']) {
    const r = new TestRunner(prisma, queue, new ReportsService(prisma, null as never, null as never));
    r.overrides.set('x', { http });
    return r;
  }
  const noEnqueue = () => jest.spyOn(queue, 'enqueue').mockImplementation(() => undefined);

  beforeAll(async () => {
    process.env.HTTP_ACTION_ALLOWLIST = 'api.example.com';
    await prisma.$connect();
    queue = new QueueService(prisma);
    triggers = new TriggersService(prisma, queue);
    const o1 = await prisma.organization.create({ data: { name: 'A' } });
    const o2 = await prisma.organization.create({ data: { name: 'B' } });
    orgId = o1.id;
    otherOrgId = o2.id;
    const u = await prisma.user.create({
      data: { orgId, email: `r-${Date.now()}@x.test`, name: 'U', passwordHash: 'x', role: 'ADMIN' },
    });
    user = { id: u.id, orgId, email: u.email, name: 'U', role: 'ADMIN' } as AuthUser;
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });
  beforeEach(() => noEnqueue());
  afterEach(() => jest.restoreAllMocks());

  it('persiste resultados por nodo, tiempos y trazabilidad', async () => {
    const { runId } = await makeRun(graph());
    await runner(async () => ({ status: 200 })).process(runId);
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      include: { steps: true, events: true },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.map((s) => s.nodeId).sort()).toEqual(['done', 'http', 't', 'task']);
    expect(run.steps.every((s) => s.status === 'SUCCEEDED' && s.finishedAt && s.durationMs >= 0)).toBe(true);
    expect(run.triggeredBy).toBe(user.id);
    const types = run.events.sort((a, b) => a.seq - b.seq).map((e) => e.type);
    expect(types[0]).toBe('run.queued');
    expect(types).toContain('run.started');
    expect(types.at(-1)).toBe('run.succeeded');
  });

  it('un fallo permanente queda registrado con su motivo y no se reintenta', async () => {
    const { runId } = await makeRun(graph());
    const http = jest.fn(async () => {
      throw new PermanentError('El servicio externo respondió HTTP 404');
    });
    await runner(http).process(runId);
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      include: { steps: true },
    });
    expect(run.status).toBe('FAILED');
    expect(http).toHaveBeenCalledTimes(1);
    const failed = run.steps.find((s) => s.nodeId === 'http');
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(failed?.error).toMatch(/404/);
    expect(run.steps.find((s) => s.nodeId === 'done')).toBeUndefined();
    expect(run.error).toMatch(/http/);
  });

  it('reintenta errores transitorios con límite y deja traza de cada intento', async () => {
    const { runId } = await makeRun(graph());
    let n = 0;
    await runner(async () => {
      if (++n < 3) throw new Error('503');
      return { status: 200 };
    }).process(runId);
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      include: { steps: true, events: true },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.find((s) => s.nodeId === 'http')?.attempts).toBe(3);
    expect(run.events.filter((e) => e.type === 'step.retry')).toHaveLength(2);
  }, 15_000);

  it('agota los reintentos y falla', async () => {
    const g = graph();
    (g.nodes[2].data as Record<string, unknown>).retries = 1;
    const { runId } = await makeRun(g);
    const http = jest.fn(async () => {
      throw new Error('503 persistente');
    });
    await runner(http).process(runId);
    expect(http).toHaveBeenCalledTimes(2);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('FAILED');
  }, 15_000);

  it('aplica el tiempo máximo por nodo', async () => {
    const g = graph();
    Object.assign(g.nodes[2].data, { retries: 0, timeoutMs: 200 });
    const { runId } = await makeRun(g);
    await runner(() => new Promise(() => undefined)).process(runId);
    const step = await prisma.workflowRunStep.findFirstOrThrow({ where: { runId, nodeId: 'http' } });
    expect(step.status).toBe('FAILED');
    expect(step.error).toMatch(/tiempo máximo/);
  });

  it('SUPERVIVENCIA A REINICIO: reanuda sin repetir pasos ni duplicar efectos', async () => {
    const { runId } = await makeRun(graph());
    // Proceso A: completa "t" y "task", y se queda colgado en "http" (el proceso "muere").
    let release: () => void = () => undefined;
    const a = runner(
      (_cfg, ctx) =>
        new Promise((_, reject) => {
          release = () => reject(new Error('proceso terminado'));
          ctx?.signal.addEventListener('abort', () => reject(new Error('abortado')));
        }),
    );
    const pendingA = a.process(runId).catch(() => undefined);
    for (let i = 0; i < 100; i++) {
      const s = await prisma.workflowRunStep.findFirst({
        where: { runId, nodeId: 'http', status: 'RUNNING' },
      });
      if (s) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await prisma.task.count({ where: { orgId, idempotencyKey: `${runId}:task` } })).toBe(1);

    // "Reinicio": el latido vence y el recuperador devuelve la corrida a la cola.
    expect(await queue.recoverStale(0)).toBeGreaterThanOrEqual(1);
    let status = (await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status;
    expect(status).toBe('QUEUED');

    // Proceso B (nuevo): reanuda desde el último checkpoint.
    const calls = jest.fn(async () => ({ status: 200 }));
    await runner(calls).process(runId);
    release();
    await pendingA;

    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      include: { steps: true, events: true },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.resumeCount).toBe(1);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(run.steps.map((s) => s.status)).toEqual(Array(4).fill('SUCCEEDED'));
    expect(
      await prisma.task.count({
        where: { orgId, source: { startsWith: 'workflow:' }, idempotencyKey: `${runId}:task` },
      }),
    ).toBe(1);
    expect(await prisma.alert.count({ where: { idempotencyKey: `${runId}:done` } })).toBe(1);
    const types = run.events.sort((x, y) => x.seq - y.seq).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['run.started', 'run.requeued', 'run.resumed', 'run.succeeded']),
    );
    expect(types.filter((t) => t === 'step.succeeded')).toHaveLength(4);
  }, 20_000);

  it('un efecto ya creado no se duplica si el nodo se repite con la misma clave', async () => {
    const { runId } = await makeRun(graph());
    const ex = new TestRunner(prisma, queue, null as never).executorsFor(orgId, 'wf', runId);
    const ctx = { signal: new AbortController().signal, idempotencyKey: `${runId}:manual` };
    const first = (await ex.notify({ severity: 'INFO', title: 't', message: 'm' }, ctx)) as {
      alertId: string;
    };
    const second = (await ex.notify({ severity: 'INFO', title: 't', message: 'm' }, ctx)) as {
      alertId: string;
    };
    expect(second.alertId).toBe(first.alertId);
    expect(await prisma.alert.count({ where: { idempotencyKey: ctx.idempotencyKey } })).toBe(1);
  });

  it('cancela una ejecución en curso: aborta el nodo y marca CANCELLED', async () => {
    const { runId } = await makeRun(graph());
    const svc = new WorkflowsService(prisma, audit, triggers);
    const r = runner(
      (_c, ctx) =>
        new Promise((_, reject) =>
          ctx?.signal.addEventListener('abort', () => reject(new Error('abortado'))),
        ),
    );
    const p = r.process(runId);
    for (let i = 0; i < 100; i++) {
      if (await prisma.workflowRunStep.findFirst({ where: { runId, nodeId: 'http', status: 'RUNNING' } }))
        break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect((await svc.cancelRun(user, runId, {} as never)).status).toBe('CANCELLING');
    await p;
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      include: { steps: true, events: true },
    });
    expect(run.status).toBe('CANCELLED');
    expect(run.cancelledBy).toBe(user.id);
    expect(run.steps.find((s) => s.nodeId === 'http')?.status).toBe('CANCELLED');
    expect(run.steps.find((s) => s.nodeId === 'done')).toBeUndefined();
    expect(run.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['run.cancel_requested', 'run.cancelled']),
    );
    await expect(svc.cancelRun(user, runId, {} as never)).rejects.toThrow(/ya terminó/);
  }, 15_000);

  it('cancela al instante una ejecución pendiente y no la ejecuta', async () => {
    const { runId } = await makeRun(graph());
    const svc = new WorkflowsService(prisma, audit, triggers);
    expect((await svc.cancelRun(user, runId, {} as never)).status).toBe('CANCELLED');
    const http = jest.fn();
    await runner(http as never).process(runId);
    expect(http).not.toHaveBeenCalled();
  });

  it('no permite cancelar ni leer ejecuciones de otra organización', async () => {
    const { runId } = await makeRun(graph());
    const svc = new WorkflowsService(prisma, audit, triggers);
    const intruder = { ...user, orgId: otherOrgId } as AuthUser;
    await expect(svc.cancelRun(intruder, runId, {} as never)).rejects.toThrow(/no encontrada/);
    await expect(svc.getRun(otherOrgId, runId)).rejects.toThrow(/no encontrada/);
    expect((await svc.listRuns(otherOrgId, 1, 50)).total).toBe(0);
  });

  it('la clave de despacho evita ejecuciones duplicadas', async () => {
    const { wf } = await makeRun(graph());
    const a = await triggers.dispatch({ id: wf.id, orgId }, 'schedule', {}, 'k-1');
    const b = await triggers.dispatch({ id: wf.id, orgId }, 'schedule', {}, 'k-1');
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it('una corrida interrumpida más de 3 veces se marca como fallida', async () => {
    const { runId } = await makeRun(graph());
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', resumeCount: 3, heartbeatAt: new Date(0) },
    });
    await queue.recoverStale(1000);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('FAILED');
  });
});
