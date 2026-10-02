const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_OUTPUT = 10_000;

/** Lectura de rutas "a.b.0.c" solo sobre propiedades propias; bloquea prototype pollution y acceso a constructor. */
export function getPath(source: unknown, path: string): unknown {
  if (!path || path.length > 200) return undefined;
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (FORBIDDEN.has(key) || current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Plantillas {{ ruta }}: sin evaluación de código, solo sustitución de valores. */
export function renderTemplate(template: string, context: unknown): string {
  const out = template.replace(/\{\{\s*([\w.-]{1,200})\s*\}\}/g, (_, path: string) =>
    stringify(getPath(context, path)),
  );
  return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) : out;
}

export function renderDeep(value: unknown, context: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (typeof value === 'string') return renderTemplate(value, context);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => renderDeep(v, context, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (FORBIDDEN.has(k)) continue;
      out[k] = renderDeep(v, context, depth + 1);
    }
    return out;
  }
  return value;
}
