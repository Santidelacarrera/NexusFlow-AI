import { evaluateCondition, executeGraph, type Executors } from './engine';
import { validateGraph, type WorkflowGraph } from './graph';

function makeExecutors(overrides: Partial<Executors> = {}): Executors & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { notify: [], task: [], http: [], report: [] };
  return {
    calls,
    notify: async (c) => (calls.notify.push(c), { ok: true }),
    task: async (c) => (calls.task.push(c), { ok: true }),
    http: async (c) => (calls.http.push(c), { status: 200 }),
    report: async (c) => (calls.report.push(c), { ok: true }),
    ...overrides,
  };
}

const saleFlow: WorkflowGraph = {
  nodes: [
    { id: 't', type: 'trigger.webhook', data: {} },
    { id: 'c', type: 'condition', data: { field: 'trigger.amount', op: 'gte', value: 1000 } },
    {
      id: 'big',
      type: 'action.notify',
      data: { severity: 'INFO', title: 'Venta grande {{trigger.id}}', message: 'Monto {{trigger.amount}}' },
    },
    { id: 'small', type: 'action.task', data: { title: 'Revisar {{trigger.id}}' } },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'c' },
    { id: 'e2', source: 'c', target: 'big', sourceHandle: 'true' },
    { id: 'e3', source: 'c', target: 'small', sourceHandle: 'false' },
  ],
};

describe('validateGraph', () => {
  it('acepta un grafo válido y detecta el tipo de trigger', () => {
    const r = validateGraph(saleFlow);
    expect(r.ok).toBe(true);
    expect(r.triggerType).toBe('trigger.webhook');
  });
  it('rechaza ciclos, triggers múltiples/ausentes, aristas rotas y tipos desconocidos', () => {
    const cyc = structuredClone(saleFlow);
    cyc.edges.push({ id: 'e4', source: 'big', target: 'c' });
    expect(validateGraph(cyc).errors.join()).toMatch(/ciclo/);

    const two = structuredClone(saleFlow);
    two.nodes.push({ id: 't2', type: 'trigger.manual', data: {} });
    expect(validateGraph(two).errors.join()).toMatch(/exactamente un nodo trigger/);

    expect(
      validateGraph({ nodes: [{ id: 'a', type: 'action.task', data: { title: 'x' } }], edges: [] }).ok,
    ).toBe(false);

    const broken = structuredClone(saleFlow);
    broken.edges.push({ id: 'e9', source: 'c', target: 'zzz', sourceHandle: 'true' });
    expect(validateGraph(broken).errors.join()).toMatch(/inexistentes/);

    expect(validateGraph({ nodes: [{ id: 'a', type: 'evil.exec', data: {} }], edges: [] }).ok).toBe(false);
    expect(validateGraph('nope').ok).toBe(false);
  });
  it('valida datos por nodo y salidas de condición', () => {
    const bad = structuredClone(saleFlow);
    bad.nodes[3].data = { title: '' };
    expect(validateGraph(bad).ok).toBe(false);
    const handle = structuredClone(saleFlow);
    handle.edges[1].sourceHandle = 'maybe';
    expect(validateGraph(handle).errors.join()).toMatch(/true.*false/);
  });
  it('limita el tamaño del grafo', () => {
    const nodes = Array.from({ length: 51 }, (_, i) => ({
      id: `n${i}`,
      type: 'action.task' as const,
      data: { title: 'x' },
    }));
    expect(validateGraph({ nodes, edges: [] }).ok).toBe(false);
  });
});

describe('evaluateCondition', () => {
  const ctx = { trigger: { n: 5, s: 'Hola Mundo', tags: ['a', 'b'], z: 0 }, data: {} };
  it.each([
    [{ field: 'trigger.n', op: 'gt', value: 4 }, true],
    [{ field: 'trigger.n', op: 'lt', value: 4 }, false],
    [{ field: 'trigger.n', op: 'eq', value: '5' }, true],
    [{ field: 'trigger.s', op: 'contains', value: 'mundo' }, true],
    [{ field: 'trigger.tags', op: 'contains', value: 'b' }, true],
    [{ field: 'trigger.n', op: 'in', value: [1, 5] }, true],
    [{ field: 'trigger.nope', op: 'exists' }, false],
    [{ field: 'trigger.z', op: 'exists' }, true],
    [{ field: 'trigger.s', op: 'gt', value: 1 }, false],
    [{ field: '__proto__.x', op: 'exists' }, false],
  ])('%j -> %s', (cfg, expected) => expect(evaluateCondition(cfg, ctx)).toBe(expected));
});

describe('executeGraph', () => {
  it('sigue la rama true y renderiza plantillas', async () => {
    const ex = makeExecutors();
    const r = await executeGraph(saleFlow, { id: 'S1', amount: 1500 }, ex);
    expect(r.status).toBe('SUCCEEDED');
    expect(r.steps.map((s) => s.nodeId)).toEqual(['t', 'c', 'big']);
    expect(ex.calls.notify[0]).toMatchObject({ title: 'Venta grande S1', message: 'Monto 1500' });
    expect(ex.calls.task).toHaveLength(0);
  });
  it('sigue la rama false', async () => {
    const ex = makeExecutors();
    const r = await executeGraph(saleFlow, { id: 'S2', amount: 10 }, ex);
    expect(r.steps.map((s) => s.nodeId)).toEqual(['t', 'c', 'small']);
    expect(ex.calls.task[0]).toMatchObject({ title: 'Revisar S2' });
  });
  it('falla rápido y registra el error del nodo', async () => {
    const ex = makeExecutors({
      notify: async () => {
        throw new Error('boom');
      },
    });
    const r = await executeGraph(saleFlow, { id: 'S3', amount: 5000 }, ex);
    expect(r.status).toBe('FAILED');
    expect(r.steps.at(-1)).toMatchObject({ nodeId: 'big', status: 'FAILED', error: 'boom' });
  });
  it('reintenta con backoff exponencial y termina con éxito', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const g: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger.manual', data: {} },
        { id: 'h', type: 'action.http', data: { url: 'https://example.com', method: 'POST', retries: 2 } },
      ],
      edges: [{ id: 'e', source: 't', target: 'h' }],
    };
    const ex = makeExecutors({
      http: async () => {
        if (++n < 3) throw new Error('flaky');
        return { status: 200 };
      },
    });
    const r = await executeGraph(g, {}, ex, {
      sleep: async (ms) => void sleeps.push(ms),
      baseBackoffMs: 100,
    });
    expect(r.status).toBe('SUCCEEDED');
    expect(n).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });
  it('encadena transform -> acción usando data', async () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger.manual', data: {} },
        { id: 'x', type: 'transform', data: { assignments: { greeting: 'Hola {{trigger.name}}' } } },
        {
          id: 'n',
          type: 'action.notify',
          data: { severity: 'INFO', title: '{{data.greeting}}', message: 'm' },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'x' },
        { id: 'e2', source: 'x', target: 'n' },
      ],
    };
    const ex = makeExecutors();
    await executeGraph(g, { name: 'Ana' }, ex);
    expect(ex.calls.notify[0]).toMatchObject({ title: 'Hola Ana' });
  });
  it('respeta el presupuesto de pasos y el plazo', async () => {
    const r = await executeGraph(saleFlow, { amount: 1 }, makeExecutors(), { maxSteps: 1 });
    expect(r.status).toBe('FAILED');
    let t = 0;
    const r2 = await executeGraph(saleFlow, { amount: 1 }, makeExecutors(), { now: () => (t += 100_000) });
    expect(r2.error).toMatch(/tiempo máximo/);
  });
  it('un payload malicioso no contamina prototipos ni ejecuta código', async () => {
    const ex = makeExecutors();
    const payload = JSON.parse('{"__proto__":{"polluted":true},"id":"${process.exit(1)}"}');
    await executeGraph(saleFlow, payload, ex);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('cada nodo se ejecuta una sola vez en caminos convergentes', async () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger.manual', data: {} },
        { id: 'a', type: 'action.task', data: { title: 'a' } },
        { id: 'b', type: 'action.task', data: { title: 'b' } },
        { id: 'j', type: 'action.notify', data: { severity: 'INFO', title: 'j', message: 'j' } },
      ],
      edges: [
        { id: '1', source: 't', target: 'a' },
        { id: '2', source: 't', target: 'b' },
        { id: '3', source: 'a', target: 'j' },
        { id: '4', source: 'b', target: 'j' },
      ],
    };
    const ex = makeExecutors();
    await executeGraph(g, {}, ex);
    expect(ex.calls.notify).toHaveLength(1);
  });
});
