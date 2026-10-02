import { getPath, renderDeep, renderTemplate } from '../common/security/safe-path';
import type { GraphNode, WorkflowGraph } from './graph';
import { TRIGGER_TYPES } from './graph';

export interface Executors {
  notify(cfg: { severity: string; title: string; message: string }): Promise<unknown>;
  task(cfg: { title: string; description?: string }): Promise<unknown>;
  http(cfg: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    integrationId?: string;
  }): Promise<unknown>;
  report(cfg: { title?: string }): Promise<unknown>;
}

export interface StepResult {
  nodeId: string;
  nodeType: string;
  status: 'SUCCEEDED' | 'FAILED';
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface EngineResult {
  status: 'SUCCEEDED' | 'FAILED';
  steps: StepResult[];
  error?: string;
}

export interface EngineOptions {
  maxSteps?: number;
  deadlineMs?: number;
  baseBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_OUTPUT_BYTES = 8_000;

export function evaluateCondition(
  cfg: { field: string; op: string; value?: unknown },
  ctx: unknown,
): boolean {
  const actual = getPath(ctx, cfg.field);
  const expected = cfg.value;
  switch (cfg.op) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'eq':
      return looseEqual(actual, expected);
    case 'neq':
      return !looseEqual(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = [Number(actual), Number(expected)];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return cfg.op === 'gt' ? a > b : cfg.op === 'gte' ? a >= b : cfg.op === 'lt' ? a < b : a <= b;
    }
    case 'contains':
      if (Array.isArray(actual)) return actual.some((x) => looseEqual(x, expected));
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    case 'in':
      return Array.isArray(expected) && expected.some((x) => looseEqual(actual, x));
    default:
      return false;
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return a === b;
}

function clampOutput(output: unknown): unknown {
  if (output === undefined) return undefined;
  const json = JSON.stringify(output);
  if (json && json.length > MAX_OUTPUT_BYTES)
    return { truncated: true, preview: json.slice(0, MAX_OUTPUT_BYTES) };
  return output;
}

/**
 * Ejecuta un grafo validado. Determinista y sin efectos secundarios propios: todo efecto pasa por `executors`.
 * Garantías: sin eval, presupuesto de pasos, plazo total, cada nodo se ejecuta una sola vez, fail-fast.
 */
export async function executeGraph(
  graph: WorkflowGraph,
  triggerPayload: unknown,
  executors: Executors,
  opts: EngineOptions = {},
): Promise<EngineResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxSteps = opts.maxSteps ?? 200;
  const deadline = now() + (opts.deadlineMs ?? 60_000);
  const backoff = opts.baseBackoffMs ?? 500;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => (TRIGGER_TYPES as readonly string[]).includes(n.type));
  if (!trigger) return { status: 'FAILED', steps: [], error: 'Sin nodo trigger' };

  const ctx = {
    trigger: triggerPayload ?? {},
    data: {} as Record<string, unknown>,
    steps: {} as Record<string, unknown>,
  };
  const steps: StepResult[] = [];
  const visited = new Set<string>();
  const queue: string[] = [trigger.id];

  while (queue.length > 0) {
    if (steps.length >= maxSteps) return { status: 'FAILED', steps, error: 'Se superó el máximo de pasos' };
    if (now() > deadline)
      return { status: 'FAILED', steps, error: 'Se superó el tiempo máximo de ejecución' };
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id) as GraphNode;

    const started = now();
    let branch: 'true' | 'false' | undefined;
    try {
      const attempts = 1 + Math.min(3, Number(node.data.retries ?? 0));
      let output: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          output = await runNode(node, ctx, executors, (b) => (branch = b));
          break;
        } catch (err) {
          if (attempt === attempts) throw err;
          await sleep(backoff * 2 ** (attempt - 1));
        }
      }
      ctx.steps[node.id] = output ?? null;
      steps.push({
        nodeId: node.id,
        nodeType: node.type,
        status: 'SUCCEEDED',
        output: clampOutput(output),
        durationMs: now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      steps.push({
        nodeId: node.id,
        nodeType: node.type,
        status: 'FAILED',
        error: message.slice(0, 500),
        durationMs: now() - started,
      });
      return { status: 'FAILED', steps, error: `Falló el nodo ${node.id}: ${message.slice(0, 300)}` };
    }

    for (const edge of graph.edges) {
      if (edge.source !== id) continue;
      if (node.type === 'condition' && edge.sourceHandle !== branch) continue;
      queue.push(edge.target);
    }
  }
  return { status: 'SUCCEEDED', steps };
}

async function runNode(
  node: GraphNode,
  ctx: { trigger: unknown; data: Record<string, unknown>; steps: Record<string, unknown> },
  ex: Executors,
  setBranch: (b: 'true' | 'false') => void,
): Promise<unknown> {
  const d = node.data;
  switch (node.type) {
    case 'condition': {
      const result = evaluateCondition(d as { field: string; op: string; value?: unknown }, ctx);
      setBranch(result ? 'true' : 'false');
      return { result };
    }
    case 'transform': {
      const out: Record<string, string> = {};
      for (const [k, tpl] of Object.entries(d.assignments as Record<string, string>)) {
        out[k] = renderTemplate(tpl, ctx);
        ctx.data[k] = out[k];
      }
      return out;
    }
    case 'action.notify':
      return ex.notify({
        severity: String(d.severity ?? 'INFO'),
        title: renderTemplate(String(d.title), ctx).slice(0, 200),
        message: renderTemplate(String(d.message), ctx).slice(0, 2000),
      });
    case 'action.task':
      return ex.task({
        title: renderTemplate(String(d.title), ctx).slice(0, 200),
        description: d.description ? renderTemplate(String(d.description), ctx).slice(0, 2000) : undefined,
      });
    case 'action.http':
      return ex.http({
        integrationId: d.integrationId as string | undefined,
        url: renderTemplate(String(d.url), ctx),
        method: String(d.method ?? 'POST'),
        headers: d.headers ? (renderDeep(d.headers, ctx) as Record<string, string>) : undefined,
        body: d.body ? renderTemplate(String(d.body), ctx) : undefined,
      });
    case 'action.report':
      return ex.report({ title: d.title ? renderTemplate(String(d.title), ctx) : undefined });
    default:
      // Nodos trigger: exponen el payload como salida.
      return { payload: ctx.trigger };
  }
}
