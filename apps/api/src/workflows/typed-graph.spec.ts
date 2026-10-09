import { executeGraph, PermanentError, type Executors } from './engine';
import { validateGraph, type WorkflowGraph } from './graph';

const ex = (o: Partial<Executors> = {}): Executors => ({
  notify: async () => ({ alertId: 'a' }),
  task: async () => ({ taskId: 't' }),
  http: async () => ({ status: 200 }),
  report: async () => ({}),
  ...o,
});

const flow = (nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph => ({
  nodes,
  edges,
});
const chain = (...ids: string[]) => ids.slice(1).map((t, i) => ({ id: `e${i}`, source: ids[i], target: t }));

describe('validación tipada: entradas y tipos', () => {
  it('detecta nodos desconectados y los nombra', () => {
    const r = validateGraph(
      flow(
        [
          { id: 't', type: 'trigger.manual', data: {} },
          { id: 'a', type: 'action.task', data: { title: 'x' } },
          { id: 'huerfano', type: 'action.task', data: { title: 'y' } },
        ],
        chain('t', 'a'),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/desconectados.*huerfano/);
  });

  it('detecta entradas que referencian nodos inexistentes, no previos o campos que el nodo no produce', () => {
    const base = [
      { id: 't', type: 'trigger.manual' as const, data: {} },
      { id: 'a', type: 'action.task' as const, data: { title: 'x' } },
    ];
    const missing = validateGraph(
      flow(
        [...base, { id: 'n', type: 'action.notify', data: { title: '{{steps.zzz.alertId}}', message: 'm' } }],
        chain('t', 'a', 'n'),
      ),
    );
    expect(missing.errors.join()).toMatch(/nodo inexistente/);

    const notBefore = validateGraph(
      flow(
        [
          ...base,
          { id: 'n', type: 'action.notify', data: { title: '{{steps.late.taskId}}', message: 'm' } },
          { id: 'late', type: 'action.task', data: { title: 'z' } },
        ],
        [
          { id: 'e1', source: 't', target: 'a' },
          { id: 'e2', source: 't', target: 'n' },
          { id: 'e3', source: 'a', target: 'late' },
        ],
      ),
    );
    expect(notBefore.errors.join()).toMatch(/no está conectada/);

    const wrongField = validateGraph(
      flow(
        [...base, { id: 'n', type: 'action.notify', data: { title: '{{steps.a.nope}}', message: 'm' } }],
        chain('t', 'a', 'n'),
      ),
    );
    expect(wrongField.errors.join()).toMatch(/no produce el campo "nope"/);

    const noData = validateGraph(
      flow(
        [...base, { id: 'n', type: 'action.notify', data: { title: '{{data.x}}', message: 'm' } }],
        chain('t', 'a', 'n'),
      ),
    );
    expect(noData.errors.join()).toMatch(/ningún transform previo/);
  });

  it('acepta referencias válidas aguas arriba', () => {
    const r = validateGraph(
      flow(
        [
          { id: 't', type: 'trigger.webhook', data: {} },
          { id: 'tf', type: 'transform', data: { assignments: { who: '{{trigger.name}}' } } },
          { id: 'a', type: 'action.task', data: { title: 'x' } },
          {
            id: 'n',
            type: 'action.notify',
            data: { title: '{{steps.a.taskId}} {{data.who}}', message: 'm' },
          },
        ],
        chain('t', 'tf', 'a', 'n'),
      ),
    );
    expect(r.errors).toEqual([]);
  });

  it('detecta tipos incompatibles en condiciones y operaciones de datos', () => {
    const cond = (op: string, field: string, value: unknown) =>
      validateGraph(
        flow(
          [
            { id: 't', type: 'trigger.manual', data: {} },
            { id: 'c0', type: 'condition', data: { field: 'trigger.x', op: 'exists' } },
            { id: 'c', type: 'condition', data: { field, op, value } },
            { id: 'a', type: 'action.task', data: { title: 'x' } },
          ],
          [
            { id: 'e1', source: 't', target: 'c0' },
            { id: 'e2', source: 'c0', target: 'c', sourceHandle: 'true' },
            { id: 'e3', source: 'c', target: 'a', sourceHandle: 'true' },
          ],
        ),
      );
    expect(cond('gt', 'steps.c0.result', 1).errors.join()).toMatch(/boolean.*numérica/);
    expect(cond('gt', 'trigger.x', 'abc').errors.join()).toMatch(/valor numérico/);
    expect(cond('in', 'trigger.x', 'abc').errors.join()).toMatch(/lista/);
    expect(cond('gt', 'trigger.x', 5).errors).toEqual([]);

    const src = validateGraph(
      flow(
        [
          { id: 't', type: 'trigger.manual', data: {} },
          { id: 'c0', type: 'condition', data: { field: 'trigger.x', op: 'exists' } },
          {
            id: 'd',
            type: 'data.operation',
            data: { operation: 'aggregate', source: 'steps.c0.result', fn: 'sum', field: 'a' },
          },
        ],
        [
          { id: 'e1', source: 't', target: 'c0' },
          { id: 'e2', source: 'c0', target: 'd', sourceHandle: 'true' },
        ],
      ),
    );
    expect(src.errors.join()).toMatch(/boolean pero se esperaba una lista/);
  });

  it('exige campo para agregaciones distintas de count y rechaza claves de ejecución de código', () => {
    const r = validateGraph(
      flow(
        [
          { id: 't', type: 'trigger.manual', data: {} },
          {
            id: 'd',
            type: 'data.operation',
            data: { operation: 'aggregate', source: 'trigger.items', fn: 'sum' },
          },
        ],
        chain('t', 'd'),
      ),
    );
    expect(r.errors.join()).toMatch(/requiere indicar el campo/);
    expect(
      validateGraph({ nodes: [{ id: 'x', type: 'code.eval', data: { code: 'process.exit()' } }], edges: [] })
        .ok,
    ).toBe(false);
  });
});

describe('nodo de operación sobre datos', () => {
  const orders = [
    { id: 1, amount: 500, customer: { name: 'A' } },
    { id: 2, amount: 1500, customer: { name: 'B' } },
    { id: 3, amount: 2500, customer: { name: 'C' } },
  ];
  const g = flow(
    [
      { id: 't', type: 'trigger.webhook', data: {} },
      {
        id: 'big',
        type: 'data.operation',
        data: { operation: 'filter', source: 'trigger.orders', field: 'amount', op: 'gte', value: 1000 },
      },
      {
        id: 'sum',
        type: 'data.operation',
        data: { operation: 'aggregate', source: 'steps.big.items', fn: 'sum', field: 'amount' },
      },
      {
        id: 'pick',
        type: 'data.operation',
        data: { operation: 'pick', source: 'steps.big.items', fields: ['id', 'customer.name'] },
      },
      {
        id: 'n',
        type: 'action.notify',
        data: { title: '{{steps.big.count}} pedidos', message: 'Total {{steps.sum.value}}' },
      },
    ],
    [
      { id: 'e1', source: 't', target: 'big' },
      { id: 'e2', source: 'big', target: 'sum' },
      { id: 'e3', source: 'big', target: 'pick' },
      { id: 'e4', source: 'sum', target: 'n' },
    ],
  );

  it('filtra, agrega y proyecta; las salidas alimentan nodos posteriores', async () => {
    expect(validateGraph(g).errors).toEqual([]);
    const notify = jest.fn(async () => ({ alertId: 'a' }));
    const r = await executeGraph(g, { orders }, ex({ notify }));
    expect(r.status).toBe('SUCCEEDED');
    const out = Object.fromEntries(r.steps.map((s) => [s.nodeId, s.output]));
    expect(out.big).toEqual({ items: orders.slice(1), count: 2 });
    expect(out.sum).toEqual({ value: 4000 });
    expect(out.pick).toEqual({
      items: [
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ],
    });
    expect(notify).toHaveBeenCalledWith(
      { severity: 'INFO', title: '2 pedidos', message: 'Total 4000' },
      expect.anything(),
    );
  });

  it('falla de forma permanente si la fuente no es una lista (sin reintentos)', async () => {
    const http = jest.fn();
    const r = await executeGraph(g, { orders: 'no-es-lista' }, ex({ http }), { baseBackoffMs: 1 });
    expect(r.status).toBe('FAILED');
    expect(r.steps.find((s) => s.nodeId === 'big')).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(r.error).toMatch(/no es una lista/);
  });

  it('agregar una lista vacía no inventa valores', async () => {
    const r = await executeGraph(g, { orders: [] }, ex(), {});
    expect(r.steps.find((s) => s.nodeId === 'sum')?.output).toEqual({ value: 0 });
  });
});

describe('errores permanentes, tiempo y cancelación en el motor', () => {
  const g = flow(
    [
      { id: 't', type: 'trigger.manual', data: {} },
      {
        id: 'h',
        type: 'action.http',
        data: { url: 'https://api.example.com/x', method: 'POST', retries: 3, timeoutMs: 150 },
      },
    ],
    chain('t', 'h'),
  );
  it('no reintenta errores permanentes', async () => {
    const http = jest.fn(async () => {
      throw new PermanentError('HTTP 400');
    });
    const r = await executeGraph(g, {}, ex({ http }), { baseBackoffMs: 1 });
    expect(http).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('FAILED');
  });
  it('reintenta tras timeout hasta agotar los intentos', async () => {
    const http = jest.fn(() => new Promise<never>(() => undefined));
    const r = await executeGraph(g, {}, ex({ http }), { baseBackoffMs: 1 });
    expect(http).toHaveBeenCalledTimes(4);
    expect(r.error).toMatch(/tiempo máximo/);
  });
  it('cancelación entre nodos', async () => {
    let calls = 0;
    const r = await executeGraph(g, {}, ex(), {}, { isCancelled: () => ++calls > 1 });
    expect(r.status).toBe('CANCELLED');
  });
  it('rechaza salidas desmedidas', async () => {
    const big = flow(
      [
        { id: 't', type: 'trigger.manual', data: {} },
        { id: 'r', type: 'action.report', data: {} },
      ],
      chain('t', 'r'),
    );
    const r = await executeGraph(big, {}, ex({ report: async () => ({ blob: 'x'.repeat(70_000) }) }));
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/límite/);
  });
});
