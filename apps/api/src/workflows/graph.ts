import { z } from 'zod';

export const TRIGGER_TYPES = [
  'trigger.manual',
  'trigger.webhook',
  'trigger.schedule',
  'trigger.churn',
  'trigger.late_order',
] as const;
export const ACTION_TYPES = ['action.notify', 'action.task', 'action.http', 'action.report'] as const;
export const NODE_TYPES = [
  ...TRIGGER_TYPES,
  'condition',
  'transform',
  'data.operation',
  ...ACTION_TYPES,
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const MAX_NODES = 50;
export const MAX_EDGES = 100;

const text = (max: number) => z.string().trim().min(1).max(max);
const retries = z.number().int().min(0).max(3).optional();
const timeoutMs = z.number().int().min(100).max(30_000).optional();
const dataPath = z
  .string()
  .trim()
  .regex(/^[\w-]+(\.[\w-]+){0,9}$/, 'Ruta inválida');

export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'in'] as const;

export const nodeDataSchemas: Record<NodeType, z.ZodType> = {
  'trigger.manual': z.object({}).passthrough(),
  'trigger.webhook': z.object({}).passthrough(),
  'trigger.schedule': z.object({ cron: z.string().trim().max(100) }),
  'trigger.churn': z.object({ minProbability: z.number().min(0).max(1).optional() }).passthrough(),
  'trigger.late_order': z.object({}).passthrough(),
  condition: z.object({
    field: text(200),
    op: z.enum(CONDITION_OPS),
    value: z
      .union([
        z.string().max(500),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string().max(200), z.number()])).max(50),
      ])
      .optional(),
  }),
  transform: z.object({
    assignments: z
      .record(z.string().regex(/^[A-Za-z_][\w]{0,49}$/), z.string().max(1000))
      .refine((r) => Object.keys(r).length <= 20, 'Máximo 20 asignaciones'),
  }),
  'data.operation': z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('filter'),
      source: dataPath,
      field: dataPath.optional(),
      op: z.enum(CONDITION_OPS),
      value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
      retries,
      timeoutMs,
    }),
    z.object({
      operation: z.literal('aggregate'),
      source: dataPath,
      fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
      field: dataPath.optional(),
      retries,
      timeoutMs,
    }),
    z.object({
      operation: z.literal('pick'),
      source: dataPath,
      fields: z.array(dataPath).min(1).max(30),
      retries,
      timeoutMs,
    }),
  ]),
  'action.notify': z.object({
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('INFO'),
    title: text(200),
    message: text(2000),
    retries,
    timeoutMs,
  }),
  'action.task': z.object({
    title: text(200),
    description: z.string().max(2000).optional(),
    retries,
    timeoutMs,
  }),
  'action.http': z.object({
    integrationId: z
      .string()
      .regex(/^[a-z0-9]{20,40}$/)
      .optional(),
    url: text(2048),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z
      .record(z.string().regex(/^[\w-]{1,64}$/), z.string().max(500))
      .refine(
        (headers) =>
          !Object.keys(headers).some((key) => /authorization|cookie|api[-_]?key|token|secret/i.test(key)),
        'Guarda las credenciales en Integraciones, no dentro del workflow',
      )
      .optional(),
    body: z.string().max(10_000).optional(),
    retries,
    timeoutMs,
  }),
  'action.report': z.object({ title: z.string().max(200).optional(), retries, timeoutMs }),
};

export interface GraphNode {
  id: string;
  type: NodeType;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const graphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{1,64}$/),
        type: z.enum(NODE_TYPES),
        data: z.record(z.string(), z.unknown()).default({}),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
      }),
    )
    .min(1)
    .max(MAX_NODES),
  edges: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{1,64}$/),
        source: z.string(),
        target: z.string(),
        sourceHandle: z.string().max(20).nullish(),
      }),
    )
    .max(MAX_EDGES),
});

// ───────────── Tipado de puertos ─────────────
export type PortType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
/** Esquema de salida de un nodo: campos con tipo conocido, o `null` si es abierto (payload externo). */
export type OutputSchema = Record<string, PortType> | null;

export function outputSchema(node: GraphNode): OutputSchema {
  const d = node.data;
  switch (node.type) {
    case 'condition':
      return { result: 'boolean' };
    case 'transform':
      return Object.fromEntries(
        Object.keys((d.assignments ?? {}) as object).map((k) => [k, 'string' as const]),
      );
    case 'data.operation':
      if (d.operation === 'filter') return { items: 'array', count: 'number' };
      if (d.operation === 'aggregate') return { value: 'number' };
      return { items: 'array', value: 'object' };
    case 'action.notify':
      return { alertId: 'string' };
    case 'action.task':
      return { taskId: 'string' };
    case 'action.http':
      return { status: 'number', bodyPreview: 'string', truncated: 'boolean', json: 'any' };
    default:
      return null;
  }
}

interface Ref {
  path: string;
  /** `value` = la ruta se usa como valor (condición, fuente de datos); `template` = interpolación de texto */
  use: 'template' | 'array' | 'numeric' | 'text-or-array';
}

const TEMPLATE_RE = /\{\{\s*([\w.-]{1,200})\s*\}\}/g;
function templateRefs(text: unknown): Ref[] {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(TEMPLATE_RE)].map((m) => ({ path: m[1], use: 'template' as const }));
}

/** Entradas que consume un nodo: rutas del contexto (`trigger.*`, `steps.<id>.*`, `data.*`). */
export function inputsOf(node: GraphNode): Ref[] {
  const d = node.data as Record<string, any>;
  switch (node.type) {
    case 'condition': {
      const use = ['gt', 'gte', 'lt', 'lte'].includes(d.op)
        ? 'numeric'
        : d.op === 'contains'
          ? 'text-or-array'
          : 'template';
      return [{ path: String(d.field ?? ''), use }];
    }
    case 'transform':
      return Object.values((d.assignments ?? {}) as Record<string, string>).flatMap(templateRefs);
    case 'data.operation':
      return [{ path: String(d.source ?? ''), use: 'array' }];
    case 'action.notify':
      return [...templateRefs(d.title), ...templateRefs(d.message)];
    case 'action.task':
      return [...templateRefs(d.title), ...templateRefs(d.description)];
    case 'action.http':
      return [
        ...templateRefs(d.url),
        ...templateRefs(d.body),
        ...Object.values((d.headers ?? {}) as Record<string, string>).flatMap(templateRefs),
      ];
    case 'action.report':
      return templateRefs(d.title);
    default:
      return [];
  }
}

function ancestorsOf(graph: WorkflowGraph, id: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  const seen = new Set<string>();
  const stack = [...(incoming.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(incoming.get(cur) ?? []));
  }
  return seen;
}

/** Comprueba que cada entrada exista aguas arriba y que su tipo sea compatible con el uso. */
function checkInputs(graph: WorkflowGraph, errors: string[]): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const node of graph.nodes) {
    const ancestors = ancestorsOf(graph, node.id);
    for (const ref of inputsOf(node)) {
      const [root, second, third] = ref.path.split('.');
      const where = `Nodo ${node.id} (${node.type}): entrada "${ref.path}"`;
      let type: PortType = 'any';
      if (root === 'trigger') {
        if (ref.use === 'template' && !second && node.type !== 'condition') type = 'object';
      } else if (root === 'steps') {
        const src = second ? byId.get(second) : undefined;
        if (!src) {
          errors.push(`${where} referencia un nodo inexistente`);
          continue;
        }
        if (!ancestors.has(src.id)) {
          errors.push(`${where} no está conectada: el nodo "${src.id}" no se ejecuta antes que este`);
          continue;
        }
        const schema = outputSchema(src);
        if (schema && third) {
          const field = third;
          if (!(field in schema)) {
            errors.push(`${where}: el nodo "${src.id}" (${src.type}) no produce el campo "${field}"`);
            continue;
          }
          type = schema[field];
        }
      } else if (root === 'data') {
        const producers = [...ancestors].map((a) => byId.get(a)).filter((n) => n?.type === 'transform');
        const producer = producers.find((n) => second in ((n?.data.assignments ?? {}) as object));
        if (!second || !producer) {
          errors.push(`${where} no existe: ningún transform previo asigna "${second ?? ''}"`);
          continue;
        }
        type = 'string';
      } else {
        errors.push(`${where} debe empezar por trigger., steps. o data.`);
        continue;
      }
      if (ref.use === 'array' && !['array', 'any'].includes(type))
        errors.push(`${where} es ${type} pero se esperaba una lista`);
      if (ref.use === 'numeric' && ['boolean', 'object', 'array'].includes(type))
        errors.push(`${where} es ${type}: tipos incompatibles con una comparación numérica`);
      if (ref.use === 'text-or-array' && ['number', 'boolean', 'object'].includes(type))
        errors.push(`${where} es ${type}: "contains" requiere texto o lista`);
    }
    if (node.type === 'condition') {
      const { op, value } = node.data as { op: string; value?: unknown };
      if (['gt', 'gte', 'lt', 'lte'].includes(op) && !Number.isFinite(Number(value)))
        errors.push(`Nodo ${node.id}: "${op}" requiere un valor numérico`);
      if (op === 'in' && !Array.isArray(value))
        errors.push(`Nodo ${node.id}: "in" requiere una lista de valores`);
      if (op !== 'exists' && value === undefined)
        errors.push(`Nodo ${node.id}: falta el valor de comparación`);
    }
    if (node.type === 'data.operation') {
      const d = node.data as { operation: string; fn?: string; field?: string };
      if (d.operation === 'aggregate' && d.fn !== 'count' && !d.field)
        errors.push(`Nodo ${node.id}: "${d.fn}" requiere indicar el campo a agregar`);
    }
  }
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  graph?: WorkflowGraph;
  triggerType?: (typeof TRIGGER_TYPES)[number];
}

/** Valida estructura, datos por tipo de nodo, trigger único, referencias de aristas y ausencia de ciclos. */
export function validateGraph(input: unknown): ValidationResult {
  const parsed = graphSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const graph = parsed.data as WorkflowGraph;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (['__proto__', 'prototype', 'constructor'].includes(n.id)) errors.push('Id de nodo reservado');
    if (ids.has(n.id)) errors.push(`Id de nodo duplicado: ${n.id}`);
    ids.add(n.id);
    const res = nodeDataSchemas[n.type].safeParse(n.data);
    if (!res.success)
      errors.push(
        `Nodo ${n.id} (${n.type}): ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    else n.data = res.data as Record<string, unknown>;
  }

  const triggers = graph.nodes.filter((n) => (TRIGGER_TYPES as readonly string[]).includes(n.type));
  if (triggers.length !== 1) errors.push('El workflow debe tener exactamente un nodo trigger');

  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) errors.push(`Id de arista duplicado: ${e.id}`);
    edgeIds.add(e.id);
    if (!ids.has(e.source) || !ids.has(e.target)) errors.push(`Arista ${e.id} referencia nodos inexistentes`);
    if (e.source === e.target) errors.push(`Arista ${e.id} es un bucle sobre sí misma`);
  }
  for (const t of triggers) {
    if (graph.edges.some((e) => e.target === t.id))
      errors.push('El trigger no puede tener aristas de entrada');
  }
  for (const c of graph.nodes.filter((n) => n.type === 'condition')) {
    for (const e of graph.edges.filter((x) => x.source === c.id)) {
      if (e.sourceHandle !== 'true' && e.sourceHandle !== 'false')
        errors.push(`Las salidas de la condición ${c.id} deben ser "true" o "false"`);
    }
  }

  for (const e of graph.edges) {
    const src = graph.nodes.find((n) => n.id === e.source);
    if (src && src.type !== 'condition' && e.sourceHandle)
      errors.push(`Arista ${e.id}: solo las condiciones tienen salidas con nombre`);
  }
  if (errors.length === 0 && hasCycle(graph)) errors.push('El workflow contiene un ciclo');
  if (errors.length === 0 && triggers.length === 1) {
    const reachable = new Set<string>(),
      pending = [triggers[0].id];
    while (pending.length) {
      const id = pending.pop() as string;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of graph.edges) if (edge.source === id) pending.push(edge.target);
    }
    if (reachable.size !== graph.nodes.length) {
      const orphans = graph.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
      errors.push(`Nodos desconectados del disparador: ${orphans.join(', ')}`);
    } else checkInputs(graph, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], graph, triggerType: triggers[0].type as (typeof TRIGGER_TYPES)[number] };
}

function hasCycle(graph: WorkflowGraph): boolean {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of graph.edges) {
    adj.get(e.source)?.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop() as string;
    seen++;
    for (const t of adj.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  return seen !== graph.nodes.length;
}
