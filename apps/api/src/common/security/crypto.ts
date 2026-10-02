import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Token aleatorio criptográficamente seguro (url-safe). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Comparación en tiempo constante, segura frente a longitudes distintas. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Cifrado autenticado AES-256-GCM. Formato: v1.iv.tag.ciphertext (base64url).
 * `aad` vincula el texto cifrado a un contexto (p. ej. el id del workflow) para evitar reutilización cruzada.
 */
export function encryptSecret(plain: string, keyB64: string, aad = ''): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('Clave de cifrado inválida');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, keyB64: string, aad = ''): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Formato de secreto inválido');
  const key = Buffer.from(keyB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** JSON canónico (claves ordenadas) para firmar/hashear de forma determinista. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',')}}`;
}
