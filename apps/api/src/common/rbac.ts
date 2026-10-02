export const ROLES = ['VIEWER', 'ANALYST', 'ADMIN', 'OWNER'] as const;
export type RoleName = (typeof ROLES)[number];

const RANK: Record<RoleName, number> = { VIEWER: 1, ANALYST: 2, ADMIN: 3, OWNER: 4 };

/** Jerarquía: un rol satisface cualquier requisito de rol igual o inferior. */
export function hasRole(actual: RoleName, minimum: RoleName): boolean {
  return RANK[actual] >= RANK[minimum];
}

/**
 * Quién puede asignar/modificar a quién (evita escalada de privilegios):
 * - OWNER gestiona a cualquiera.
 * - ADMIN solo gestiona roles estrictamente inferiores al suyo y no puede otorgar ADMIN/OWNER.
 * - Nadie se modifica a sí mismo el rol.
 */
export function canManage(actor: RoleName, target: RoleName, newRole: RoleName | undefined, selfEdit: boolean): boolean {
  if (selfEdit && newRole !== undefined) return false;
  if (actor === 'OWNER') return true;
  if (actor !== 'ADMIN') return false;
  if (RANK[target] >= RANK.ADMIN) return false;
  if (newRole !== undefined && RANK[newRole] >= RANK.ADMIN) return false;
  return true;
}
