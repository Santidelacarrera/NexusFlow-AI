import { createHmac } from 'node:crypto';
import { loadEnv } from '../config/env';
import { canonicalize, decryptSecret, encryptSecret, safeEqual } from './crypto';
import { sanitizeCell } from './csv-sanitize';
import { signAccessToken, verifyAccessToken } from './jwt';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './password';
import { getPath, renderDeep, renderTemplate } from './safe-path';
import { isPrivateAddress, validateUrlSyntax } from './ssrf';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'x'.repeat(40);

describe('password', () => {
  it('hashea y verifica, rechaza contraseñas incorrectas y hashes malformados', async () => {
    const h = await hashPassword('Correct-Horse-9');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('correct-horse-9', h)).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AA$AA')).toBe(false);
  });
  it('genera sal distinta en cada hash', async () => {
    expect(await hashPassword('Same-Password-1')).not.toEqual(await hashPassword('Same-Password-1'));
  });
  it('aplica la política de contraseñas', () => {
    expect(checkPasswordPolicy('corta1A!').ok).toBe(false);
    expect(checkPasswordPolicy('todominusculasaqui').ok).toBe(false);
    expect(checkPasswordPolicy('Password12345').ok).toBe(false);
    expect(checkPasswordPolicy('Santiago-Seguro-77', { email: 'santiago@x.com' }).ok).toBe(false);
    expect(checkPasswordPolicy('Un-Buen-Secreto-2026').ok).toBe(true);
  });
});

describe('jwt', () => {
  it('firma y verifica', () => {
    const t = signAccessToken('u1', 'o1', SECRET);
    expect(verifyAccessToken(t, SECRET)).toMatchObject({ sub: 'u1', org: 'o1' });
  });
  it('rechaza firma incorrecta, expirado, alg none y manipulación del payload', () => {
    const t = signAccessToken('u1', 'o1', SECRET, 60, 1_000_000);
    expect(verifyAccessToken(t, 'y'.repeat(40), 1_000_000)).toBeNull();
    expect(verifyAccessToken(t, SECRET, 1_000_000 + 61_000)).toBeNull();
    const [h, b] = t.split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyAccessToken(`${none}.${b}.`, SECRET, 1_000_000)).toBeNull();
    const evil = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url');
    expect(verifyAccessToken(`${h}.${evil}.${t.split('.')[2]}`, SECRET, 1_000_000)).toBeNull();
    expect(verifyAccessToken('a.b', SECRET)).toBeNull();
    expect(verifyAccessToken('x'.repeat(5000), SECRET)).toBeNull();
  });
  it('rechaza tokens firmados con otro issuer/audience', () => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const b = Buffer.from(
      JSON.stringify({ sub: 'u', org: 'o', iss: 'otro', aud: 'nexusflow-web', exp: 9_999_999_999 }),
    ).toString('base64url');
    const s = createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
    expect(verifyAccessToken(`${h}.${b}.${s}`, SECRET)).toBeNull();
  });
});

describe('crypto', () => {
  it('cifra/descifra con AES-GCM y detecta manipulación o contexto distinto', () => {
    const enc = encryptSecret('super-secreto', KEY, 'wf1');
    expect(enc).not.toContain('super-secreto');
    expect(decryptSecret(enc, KEY, 'wf1')).toBe('super-secreto');
    expect(() => decryptSecret(enc, KEY, 'wf2')).toThrow();
    const tampered = enc.slice(0, -2) + (enc.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, KEY, 'wf1')).toThrow();
    expect(encryptSecret('a', KEY)).not.toEqual(encryptSecret('a', KEY));
  });
  it('safeEqual y canonicalize', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });
});

describe('safe-path', () => {
  it('lee rutas propias y bloquea prototype pollution', () => {
    const ctx = { a: { b: [{ c: 5 }] } };
    expect(getPath(ctx, 'a.b.0.c')).toBe(5);
    expect(getPath(ctx, '__proto__.polluted')).toBeUndefined();
    expect(getPath(ctx, 'a.constructor')).toBeUndefined();
    expect(getPath(ctx, 'a.toString')).toBeUndefined();
    expect(getPath(JSON.parse('{"__proto__":{"x":1}}'), '__proto__.x')).toBeUndefined();
  });
  it('renderiza plantillas sin ejecutar código', () => {
    expect(renderTemplate('Hola {{ user.name }} {{ missing }}!', { user: { name: 'Ana' } })).toBe(
      'Hola Ana !',
    );
    expect(renderTemplate('{{ process.env.SECRET }}', {})).toBe('');
    expect(renderTemplate('${1+1} {{1+1}}', {})).toBe('${1+1} {{1+1}}');
    expect(renderDeep({ x: ['{{a}}'], __proto__: { y: 1 } }, { a: 1 })).toEqual({ x: ['1'] });
  });
});

describe('csv-sanitize', () => {
  it('neutraliza fórmulas', () => {
    expect(sanitizeCell('=cmd|"/c calc"!A1')).toBe('\'=cmd|"/c calc"!A1');
    expect(sanitizeCell('+1+1')).toBe("'+1+1");
    expect(sanitizeCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(sanitizeCell('  Ana  ')).toBe('Ana');
    expect(sanitizeCell('ok\u0000')).toBe('ok');
  });
});

describe('ssrf', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.5.5',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe80::1',
    'fd00::1',
    '2002:7f00:1::',
    'not-an-ip',
  ])('bloquea %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])('permite %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it('valida URLs', () => {
    const p = { allowlist: [] as string[] };
    expect(() => validateUrlSyntax('http://example.com', p)).toThrow();
    expect(() => validateUrlSyntax('https://user:pw@example.com', p)).toThrow();
    expect(() => validateUrlSyntax('https://example.com:22', p)).toThrow();
    expect(() => validateUrlSyntax('https://localhost', p)).toThrow();
    expect(() => validateUrlSyntax('https://169.254.169.254/latest', p)).toThrow();
    expect(() => validateUrlSyntax('https://[::1]/', p)).toThrow();
    expect(() => validateUrlSyntax('https://intranet.internal/', p)).toThrow();
    expect(() => validateUrlSyntax('file:///etc/passwd', p)).toThrow();
    expect(() => validateUrlSyntax('https://example.com/hook', p)).not.toThrow();
    expect(() => validateUrlSyntax('https://example.com/hook', { allowlist: ['api.acme.com'] })).toThrow();
    expect(() =>
      validateUrlSyntax('https://api.acme.com/hook', { allowlist: ['api.acme.com'] }),
    ).not.toThrow();
  });
});

describe('env', () => {
  const base = {
    DATABASE_URL: 'postgresql://x',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    DATA_ENCRYPTION_KEY: KEY,
    AUDIT_HMAC_KEY: 'b'.repeat(40),
    ML_SERVICE_TOKEN: 'c'.repeat(40),
  };
  it('acepta una configuración válida', () =>
    expect(loadEnv({ ...base })).toMatchObject({ PORT: 3000, ALLOW_REGISTRATION: true }));
  it('rechaza CORS comodín, claves cortas y valores de ejemplo en producción', () => {
    expect(() => loadEnv({ ...base, CORS_ORIGINS: '*' })).toThrow(/CORS/);
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'corta' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me'.padEnd(40, 'x') }),
    ).toThrow(/inseguro/);
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: 'AAAA' })).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
