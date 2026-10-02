import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessClaims {
  sub: string;
  org: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  sid?: string;
}

const ISSUER = 'nexusflow-api';
const AUDIENCE = 'nexusflow-web';
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signAccessToken(
  sub: string,
  org: string,
  secret: string,
  ttlSeconds = 900,
  now = Date.now(),
  sid?: string,
): string {
  const iat = Math.floor(now / 1000);
  const claims: AccessClaims = { sub, org, iat, exp: iat + ttlSeconds, iss: ISSUER, aud: AUDIENCE, sid };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${HEADER}.${body}.${sign(`${HEADER}.${body}`, secret)}`;
}

/** Verificación estricta: algoritmo fijo HS256 (sin confusión de algoritmos ni "none"), firma, exp, iss y aud. */
export function verifyAccessToken(token: string, secret: string, now = Date.now()): AccessClaims | null {
  if (token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  if (h !== HEADER) return null;
  const expected = Buffer.from(sign(`${h}.${b}`, secret));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as AccessClaims;
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) return null;
    if (typeof claims.sub !== 'string' || typeof claims.org !== 'string') return null;
    if (!Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now) return null;
    if (!Number.isSafeInteger(claims.iat) || claims.iat * 1000 > now + 30_000) return null;
    if (claims.sid !== undefined && (typeof claims.sid !== 'string' || claims.sid.length > 200)) return null;
    return claims;
  } catch {
    return null;
  }
}
