import { z } from 'zod';

export const TRIGGER_TYPES = [
  'trigger.manual',
  'trigger.webhook',
  'trigger.schedule',
  'trigger.churn',
  'trigger.late_order',
] as const;
export const ACTION_TYPES = ['action.notify', 'action.task', 'action.http', 'action.report'] as const;
export const NODE_TYPES = [...TRIGGER_TYPES, 'condition', 'transform', ...ACTION_TYPES] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const MAX_NODES = 50;
export const MAX_EDGES = 100;

const text = (max: number) => z.string().trim().min(1).max(max);
const retries = z.number().int().min(0).max(3).optional();

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
  'action.notify': z.object({
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('INFO'),
    title: text(200),
    message: text(2000),
    retries,
  }),
  'action.task': z.object({ title: text(200), description: z.string().max(2000).optional(), retries }),
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
  }),
  'action.report': z.object({ title: z.string().max(200).optional(), retries }),
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
    if (reachable.size !== graph.nodes.length)
      errors.push('Todos los nodos deben estar conectados al disparador');
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
