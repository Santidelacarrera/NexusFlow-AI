import { canManage, hasRole } from './rbac';

describe('rbac', () => {
  it('jerarquía de roles', () => {
    expect(hasRole('OWNER', 'ADMIN')).toBe(true);
    expect(hasRole('ANALYST', 'ANALYST')).toBe(true);
    expect(hasRole('VIEWER', 'ANALYST')).toBe(false);
    expect(hasRole('ADMIN', 'OWNER')).toBe(false);
  });
  it('previene escalada de privilegios', () => {
    expect(canManage('OWNER', 'ADMIN', 'VIEWER', false)).toBe(true);
    expect(canManage('ADMIN', 'ANALYST', 'VIEWER', false)).toBe(true);
    expect(canManage('ADMIN', 'ANALYST', 'ADMIN', false)).toBe(false);
    expect(canManage('ADMIN', 'ADMIN', undefined, false)).toBe(false);
    expect(canManage('ADMIN', 'OWNER', undefined, false)).toBe(false);
    expect(canManage('ANALYST', 'VIEWER', 'ANALYST', false)).toBe(false);
    expect(canManage('OWNER', 'OWNER', 'VIEWER', true)).toBe(false);
  });
});
