import { getPath, renderDeep, renderTemplate } from '../common/security/safe-path';
import type { GraphNode, WorkflowGraph } from './graph';
import { TRIGGER_TYPES } from './graph';

export interface ExecContext {
  /** Se aborta al agotar el tiempo del nodo o al cancelar la ejecución. */
  signal: AbortSignal;
  /** Estable entre reintentos y reanudaciones del mismo nodo: permite deduplicar efectos externos. */
  idempotencyKey: string;
}

export interface Executors {
  notify(cfg: { severity: string; title: string; message: string }, ctx?: ExecContext): Promise<unknown>;
  task(cfg: { title: string; description?: string }, ctx?: ExecContext): Promise<unknown>;
  http(
    cfg: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string;
      integrationId?: string;
    },
    ctx?: ExecContext,
  ): Promise<unknown>;
  report(cfg: { title?: string }, ctx?: ExecContext): Promise<unknown>;
}

/** Error que no debe reintentarse (p. ej. HTTP 4xx, configuración inválida). */
export class PermanentError extends Error {
  readonly permanent = true;
}
export class CancelledError extends Error {
  constructor() {
    super('Ejecución cancelada');
  }
}
export class NodeTimeoutError extends Error {
  constructor(ms: number) {
    super(`El nodo superó su tiempo máximo (${ms} ms)`);
  }
}

export interface StepResult {
  nodeId: string;
  nodeType: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  output?: unknown;
  error?: string;
  durationMs: number;
  attempts?: number;
}

export interface EngineResult {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  steps: StepResult[];
  error?: string;
}

/** Puntos de integración con la persistencia: el motor no conoce la base de datos. */
export interface RunHooks {
  /** Pasos ya completados antes de un reinicio: se reconstruye el contexto sin repetir sus efectos. */
  completed?: Map<string, StepResult>;
  isCancelled?: () => Promise<boolean> | boolean;
  /** Se aborta cuando el usuario cancela dentro de este mismo proceso. */
  signal?: AbortSignal;
  onStepStart?: (node: { id: string; type: string }, attempt: number) => Promise<void> | void;
  onRetry?: (
    node: { id: string; type: string },
    attempt: number,
    error: string,
    delayMs: number,
  ) => Promise<void> | void;
  onStepEnd?: (step: StepResult) => Promise<void> | void;
}

export interface EngineOptions {
  maxSteps?: number;
  deadlineMs?: number;
  baseBackoffMs?: number;
  defaultNodeTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  runId?: string;
}

const MAX_OUTPUT_BYTES = 64_000;
const MAX_DATA_ITEMS = 5_000;
const DEFAULT_NODE_TIMEOUT_MS = 15_000;

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

function checkOutput(output: unknown): unknown {
  if (output === undefined) return undefined;
  const json = JSON.stringify(output);
  if (json && json.length > MAX_OUTPUT_BYTES)
    throw new PermanentError(`La salida del nodo supera el límite de ${MAX_OUTPUT_BYTES} bytes`);
  return output;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Ejecuta `fn` con un plazo; al vencer aborta la señal para que el trabajo subyacente se detenga. */
async function withTimeout<T>(
  ms: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParent = () => controller.abort();
  if (parent?.aborted) throw new CancelledError();
  parent?.addEventListener('abort', onParent, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new NodeTimeoutError(ms));
        }, ms);
        controller.signal.addEventListener('abort', () => {
          if (parent?.aborted) reject(new CancelledError());
        });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}

type Ctx = { trigger: unknown; data: Record<string, unknown>; steps: Record<string, unknown> };

/**
 * Ejecuta un grafo validado. Determinista y sin efectos secundarios propios: todo efecto pasa por `executors`.
 * Garantías: sin eval, presupuesto de pasos, plazo total y por nodo, cada nodo se ejecuta una sola vez,
 * reintentos acotados solo para errores transitorios, cancelación cooperativa y reanudación desde `hooks.completed`.
 */
export async function executeGraph(
  graph: WorkflowGraph,
  triggerPayload: unknown,
  executors: Executors,
  opts: EngineOptions = {},
  hooks: RunHooks = {},
): Promise<EngineResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const maxSteps = opts.maxSteps ?? 200;
  const deadline = now() + (opts.deadlineMs ?? 60_000);
  const backoff = opts.baseBackoffMs ?? 500;
  const defaultTimeout = opts.defaultNodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => (TRIGGER_TYPES as readonly string[]).includes(n.type));
  if (!trigger) return { status: 'FAILED', steps: [], error: 'Sin nodo trigger' };

  const ctx: Ctx = { trigger: triggerPayload ?? {}, data: {}, steps: {} };
  const steps: StepResult[] = [];
  const visited = new Set<string>();
  const queue: string[] = [trigger.id];
  const cancelled = async () => hooks.signal?.aborted === true || (await hooks.isCancelled?.()) === true;

  while (queue.length > 0) {
    if (await cancelled()) return { status: 'CANCELLED', steps, error: 'Ejecución cancelada' };
    if (steps.length >= maxSteps) return { status: 'FAILED', steps, error: 'Se superó el máximo de pasos' };
    if (now() > deadline)
      return { status: 'FAILED', steps, error: 'Se superó el tiempo máximo de ejecución' };
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id) as GraphNode;

    let branch: 'true' | 'false' | undefined;
    const done = hooks.completed?.get(id);
    if (done && done.status === 'SUCCEEDED') {
      // Reanudación: se reconstruye el efecto del paso en el contexto sin volver a ejecutarlo.
      ctx.steps[id] = done.output ?? null;
      if (node.type === 'condition')
        branch = (done.output as { result?: boolean })?.result ? 'true' : 'false';
      if (node.type === 'transform') Object.assign(ctx.data, done.output as object);
      steps.push(done);
    } else {
      const started = now();
      let attempts = 0;
      try {
        const attemptsAllowed = 1 + Math.min(3, Number(node.data.retries ?? 0));
        const timeoutMs = Number(node.data.timeoutMs ?? defaultTimeout);
        let output: unknown;
        for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
          attempts = attempt;
          await hooks.onStepStart?.(node, attempt);
          try {
            const ex: ExecContext = {
              signal: undefined as unknown as AbortSignal,
              idempotencyKey: `${opts.runId ?? 'run'}:${node.id}`,
            };
            output = await withTimeout(timeoutMs, hooks.signal, (signal) => {
              ex.signal = signal;
              return runNode(node, ctx, executors, ex, (b) => (branch = b));
            });
            output = checkOutput(output);
            break;
          } catch (err) {
            if (err instanceof CancelledError || hooks.signal?.aborted) throw new CancelledError();
            const permanent = (err as { permanent?: boolean }).permanent === true;
            if (attempt === attemptsAllowed || permanent) throw err;
            const delay = backoff * 2 ** (attempt - 1);
            await hooks.onRetry?.(node, attempt, (err as Error).message.slice(0, 300), delay);
            await sleep(delay, hooks.signal);
            if (await cancelled()) throw new CancelledError();
          }
        }
        ctx.steps[node.id] = output ?? null;
        const step: StepResult = {
          nodeId: node.id,
          nodeType: node.type,
          status: 'SUCCEEDED',
          output,
          durationMs: now() - started,
          attempts,
        };
        steps.push(step);
        await hooks.onStepEnd?.(step);
      } catch (err) {
        const isCancel = err instanceof CancelledError;
        const message = err instanceof Error ? err.message : 'Error desconocido';
        const step: StepResult = {
          nodeId: node.id,
          nodeType: node.type,
          status: isCancel ? 'CANCELLED' : 'FAILED',
          error: message.slice(0, 500),
          durationMs: now() - started,
          attempts,
        };
        steps.push(step);
        await hooks.onStepEnd?.(step);
        if (isCancel) return { status: 'CANCELLED', steps, error: 'Ejecución cancelada' };
        return { status: 'FAILED', steps, error: `Falló el nodo ${node.id}: ${message.slice(0, 300)}` };
      }
    }

    for (const edge of graph.edges) {
      if (edge.source !== id) continue;
      if (node.type === 'condition' && edge.sourceHandle !== branch) continue;
      queue.push(edge.target);
    }
  }
  return { status: 'SUCCEEDED', steps };
}

function dataOperation(d: Record<string, any>, ctx: Ctx): unknown {
  const source = getPath(ctx, String(d.source));
  if (d.operation === 'pick') {
    const pick = (o: unknown) =>
      Object.fromEntries(
        (d.fields as string[]).map((f) => [f.split('.').pop() as string, getPath(o, f) ?? null]),
      );
    if (Array.isArray(source)) return { items: source.slice(0, MAX_DATA_ITEMS).map(pick) };
    if (source && typeof source === 'object') return { value: pick(source) };
    throw new PermanentError(`La fuente "${d.source}" no es un objeto ni una lista`);
  }
  if (!Array.isArray(source)) throw new PermanentError(`La fuente "${d.source}" no es una lista`);
  if (source.length > MAX_DATA_ITEMS) throw new PermanentError(`La lista supera ${MAX_DATA_ITEMS} elementos`);
  if (d.operation === 'filter') {
    const items = source.filter((item) => {
      const subject = d.field ? item : { v: item };
      return evaluateCondition({ field: d.field ?? 'v', op: d.op, value: d.value }, subject);
    });
    return { items, count: items.length };
  }
  const values = source.map((i) => (d.field ? getPath(i, d.field) : i));
  if (d.fn === 'count') return { value: source.length };
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length === 0) return { value: d.fn === 'sum' ? 0 : null };
  const total = nums.reduce((a, b) => a + b, 0);
  const value =
    d.fn === 'sum'
      ? total
      : d.fn === 'avg'
        ? total / nums.length
        : d.fn === 'min'
          ? Math.min(...nums)
          : Math.max(...nums);
  return { value: Math.round(value * 1e6) / 1e6 };
}

async function runNode(
  node: GraphNode,
  ctx: Ctx,
  ex: Executors,
  exec: ExecContext,
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
    case 'data.operation':
      return dataOperation(d, ctx);
    case 'action.notify':
      return ex.notify(
        {
          severity: String(d.severity ?? 'INFO'),
          title: renderTemplate(String(d.title), ctx).slice(0, 200),
          message: renderTemplate(String(d.message), ctx).slice(0, 2000),
        },
        exec,
      );
    case 'action.task':
      return ex.task(
        {
          title: renderTemplate(String(d.title), ctx).slice(0, 200),
          description: d.description ? renderTemplate(String(d.description), ctx).slice(0, 2000) : undefined,
        },
        exec,
      );
    case 'action.http':
      return ex.http(
        {
          integrationId: d.integrationId as string | undefined,
          url: renderTemplate(String(d.url), ctx),
          method: String(d.method ?? 'POST'),
          headers: d.headers ? (renderDeep(d.headers, ctx) as Record<string, string>) : undefined,
          body: d.body ? renderTemplate(String(d.body), ctx) : undefined,
        },
        exec,
      );
    case 'action.report':
      return ex.report({ title: d.title ? renderTemplate(String(d.title), ctx) : undefined }, exec);
    default:
      // Nodos trigger: exponen el payload como salida.
      return { payload: ctx.trigger };
  }
}
