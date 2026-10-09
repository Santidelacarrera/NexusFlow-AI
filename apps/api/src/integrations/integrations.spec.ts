import { IntegrationsService } from './integrations.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { resetEnvCache } from '../common/config/env';
import { decryptSecret } from '../common/security/crypto';
import type { AuthUser } from '../common/http/types';

describe('credenciales de integraciones', () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  const actor: AuthUser = {
    id: 'actor',
    orgId: 'org-a',
    role: 'ADMIN',
    email: 'admin@example.com',
    name: 'Admin',
  };
  beforeAll(() => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://unused',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
      AUDIT_HMAC_KEY: 'y'.repeat(40),
      ML_SERVICE_TOKEN: 'z'.repeat(40),
      DATA_ENCRYPTION_KEY: key,
      HTTP_ACTION_ALLOWLIST: 'api.example.com',
    });
    resetEnvCache();
  });
  afterAll(resetEnvCache);
  it('cifra con contexto y devuelve solo metadatos seguros', async () => {
    const update = jest.fn().mockImplementation(({ data, select }) => {
      expect(select.headersEnc).toBeUndefined();
      return { id: 'integration-id', name: 'CRM', baseUrl: 'https://api.example.com' };
    });
    const tx = { integration: { create: jest.fn().mockResolvedValue({ id: 'integration-id' }), update } };
    const prisma = {
      integration: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    } as unknown as PrismaService;
    const audit = { record: jest.fn() } as unknown as AuditService;
    const result = await new IntegrationsService(prisma, audit, (async () => ({
      status: 200,
      body: '',
      truncated: false,
    })) as never).create(
      actor,
      {
        name: 'CRM',
        baseUrl: 'https://api.example.com/v1',
        headers: { Authorization: 'Bearer sensitive-token' },
      },
      { ip: '127.0.0.1', userAgent: 'test' },
    );
    const encrypted = update.mock.calls[0][0].data.headersEnc;
    expect(encrypted).not.toContain('sensitive-token');
    expect(JSON.parse(decryptSecret(encrypted, key, 'integration-id'))).toEqual({
      Authorization: 'Bearer sensitive-token',
    });
    expect(() => decryptSecret(encrypted, key, 'another-id')).toThrow();
    expect(result).not.toHaveProperty('headersEnc');
  });
  it('rechaza destinos fuera de la allowlist antes de guardar datos', async () => {
    const service = new IntegrationsService(
      {} as PrismaService,
      {} as AuditService,
      (async () => ({ status: 200, body: '', truncated: false })) as never,
    );
    await expect(
      service.create(
        actor,
        { name: 'Unsafe', baseUrl: 'https://127.0.0.1', headers: {} },
        { ip: '', userAgent: '' },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
