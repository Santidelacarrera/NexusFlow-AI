import { AuditEntryCore, computeAuditHash, GENESIS_HASH, verifyAuditChain } from './audit-chain';

const KEY = 'k'.repeat(40);

function build(n: number) {
  const out: Array<AuditEntryCore & { hash: string }> = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const core: AuditEntryCore = {
      orgId: 'o1',
      seq: i,
      userId: 'u1',
      action: `a${i}`,
      resource: 'r',
      resourceId: String(i),
      ip: '1.1.1.1',
      metadata: { n: i },
      createdAt: new Date(2026, 0, i),
      prevHash: prev,
    };
    const hash = computeAuditHash(KEY, core);
    out.push({ ...core, hash });
    prev = hash;
  }
  return out;
}

describe('audit chain', () => {
  it('verifica una cadena íntegra', () =>
    expect(verifyAuditChain(build(5), KEY)).toEqual({ valid: true, checked: 5 }));
  it('detecta contenido alterado', () => {
    const c = build(5);
    c[2].action = 'tampered';
    expect(verifyAuditChain(c, KEY)).toMatchObject({ valid: false, brokenAtSeq: 3 });
  });
  it('detecta entradas borradas', () => {
    const c = build(5);
    c.splice(2, 1);
    expect(verifyAuditChain(c, KEY)).toMatchObject({ valid: false, brokenAtSeq: 3 });
  });
  it('detecta reordenamiento y clave incorrecta', () => {
    const c = build(4);
    [c[1], c[2]] = [c[2], c[1]];
    expect(verifyAuditChain(c, KEY).valid).toBe(false);
    expect(verifyAuditChain(build(3), 'otra-clave'.padEnd(40, 'x')).valid).toBe(false);
  });
  it('detecta un recálculo del hash sin la clave (atacante con acceso de escritura a BD)', () => {
    const c = build(3);
    c[1].action = 'forged';
    c[1].hash = 'f'.repeat(64);
    expect(verifyAuditChain(c, KEY).valid).toBe(false);
  });
  it('lista vacía es válida', () => expect(verifyAuditChain([], KEY).valid).toBe(true));
});
