const SENSITIVE_KEY = /authorization|cookie|passw(or)?d|secret|token|api[-_]?key|signature|credential/i;
const MASK = '[REDACTED]';

/** Copia profunda que enmascara por nombre de clave. Se aplica a todo lo que se persiste o registra de una ejecución. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 200))
      out[k] = SENSITIVE_KEY.test(k) ? MASK : redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

/** Elimina valores secretos conocidos (p. ej. cabeceras de una integración) de un texto, como un mensaje de error. */
export function redactText(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join(MASK);
  return out;
}
