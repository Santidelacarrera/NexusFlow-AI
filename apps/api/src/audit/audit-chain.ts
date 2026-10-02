import { canonicalize, hmacHex } from '../common/security/crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntryCore {
  orgId: string;
  seq: number;
  userId: string | null;
  action: string;
  resource: string | null;
  resourceId: string | null;
  ip: string | null;
  metadata: unknown;
  createdAt: Date;
  prevHash: string;
}

/** HMAC-SHA256 encadenado: cada entrada firma su contenido + el hash de la anterior (log tamper-evident). */
export function computeAuditHash(key: string, e: AuditEntryCore): string {
  return hmacHex(
    key,
    canonicalize({
      orgId: e.orgId,
      seq: e.seq,
      userId: e.userId,
      action: e.action,
      resource: e.resource,
      resourceId: e.resourceId,
      ip: e.ip,
      metadata: e.metadata ?? null,
      createdAt: e.createdAt.toISOString(),
      prevHash: e.prevHash,
    }),
  );
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/** Verificador incremental (permite recorrer cadenas largas por lotes). Detecta modificación, borrado, reordenamiento e inserción. */
export class ChainVerifier {
  private prev = GENESIS_HASH;
  private expectedSeq = 1;
  checked = 0;

  constructor(private readonly key: string) {}

  /** Devuelve null si la entrada es correcta, o el motivo del fallo. */
  push(e: AuditEntryCore & { hash: string }): ChainVerification | null {
    const fail = (reason: string): ChainVerification => ({
      valid: false,
      checked: this.checked,
      brokenAtSeq: this.expectedSeq,
      reason,
    });
    if (e.seq !== this.expectedSeq) return fail('Falta una entrada (hueco en la secuencia)');
    if (e.prevHash !== this.prev) return fail('prevHash no coincide con la entrada anterior');
    if (computeAuditHash(this.key, e) !== e.hash) return fail('Contenido alterado');
    this.prev = e.hash;
    this.expectedSeq++;
    this.checked++;
    return null;
  }

  result(): ChainVerification {
    return { valid: true, checked: this.checked };
  }
}

export function verifyAuditChain(
  entries: Array<AuditEntryCore & { hash: string }>,
  key: string,
): ChainVerification {
  const v = new ChainVerifier(key);
  for (const e of entries) {
    const err = v.push(e);
    if (err) return err;
  }
  return v.result();
}
