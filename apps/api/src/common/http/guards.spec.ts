import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard } from './guards';
import { PrismaService } from '../../prisma/prisma.service';
import { signAccessToken } from '../security/jwt';
import { resetEnvCache } from '../config/env';

describe('guards de autenticación y aislamiento', () => {
  const secret = 'x'.repeat(48);
  beforeAll(() => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://unused',
      JWT_ACCESS_SECRET: secret,
      AUDIT_HMAC_KEY: secret,
      ML_SERVICE_TOKEN: secret,
      DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    });
    resetEnvCache();
  });
  afterAll(resetEnvCache);
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  function context(request: unknown) {
    return {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }
  it('rechaza sesiones revocadas aunque la firma JWT siga siendo válida', async () => {
    const prisma = {
      refreshToken: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const token = signAccessToken('u', 'org', secret, 900, Date.now(), 'family');
    await expect(
      new JwtAuthGuard(reflector, prisma).canActivate(
        context({ headers: { authorization: `Bearer ${token}` } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rechaza organización distinta o usuario desactivado', async () => {
    const request = {
      headers: { authorization: `Bearer ${signAccessToken('u', 'org', secret, 900, Date.now(), 'family')}` },
    };
    for (const user of [
      { id: 'u', orgId: 'other', isActive: true },
      { id: 'u', orgId: 'org', isActive: false },
    ]) {
      const prisma = {
        refreshToken: { findFirst: jest.fn().mockResolvedValue({ id: 'session' }) },
        user: { findUnique: jest.fn().mockResolvedValue(user) },
      } as unknown as PrismaService;
      await expect(new JwtAuthGuard(reflector, prisma).canActivate(context(request))).rejects.toMatchObject({
        status: 401,
      });
    }
  });
  it('un VIEWER no satisface un endpoint de ANALYST', () => {
    const roles = { getAllAndOverride: () => 'ANALYST' } as unknown as Reflector;
    expect(() => new RolesGuard(roles).canActivate(context({ user: { role: 'VIEWER' } }))).toThrow(
      'Permisos insuficientes',
    );
  });
});
