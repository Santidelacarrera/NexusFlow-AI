import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Hash con scrypt (memory-hard). Formato: scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * N * R });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every(Number.isInteger) || n > 2 ** 20 || r > 32 || p > 4) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: 256 * n * r });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/** Verificación ficticia para igualar tiempos cuando el usuario no existe (evita enumeración por timing). */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('nexusflow-dummy-password');
  await verifyPassword(password, await dummyHash);
}

const COMMON = new Set([
  'password1234', 'contraseña123', 'qwertyuiop12', '123456789012', 'administrator', 'letmein12345',
  'welcome12345', 'iloveyou1234', 'password12345', 'passw0rd1234',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

export function checkPasswordPolicy(password: string, context: { email?: string; name?: string } = {}): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, reason: 'La contraseña debe tener al menos 12 caracteres' };
  if (password.length > 128) return { ok: false, reason: 'La contraseña no puede superar 128 caracteres' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return { ok: false, reason: 'Usa al menos 3 tipos de caracteres (minúsculas, mayúsculas, números, símbolos)' };
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return { ok: false, reason: 'La contraseña es demasiado común' };
  if (/^(.)\1+$/.test(password)) return { ok: false, reason: 'La contraseña es demasiado repetitiva' };
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return { ok: false, reason: 'La contraseña no puede contener tu email' };
  const name = context.name?.toLowerCase().replace(/\s+/g, '');
  if (name && name.length >= 4 && lower.includes(name)) return { ok: false, reason: 'La contraseña no puede contener tu nombre' };
  return { ok: true };
}
