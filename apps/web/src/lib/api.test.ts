import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, refresh, setToken } from './api';
afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});
describe('cliente de API', () => {
  it('agrupa renovaciones concurrentes para evitar reutilizar refresh tokens', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: 'nuevo', user: { id: 'u' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', request);
    await Promise.all([refresh(), refresh(), refresh()]);
    expect(request).toHaveBeenCalledTimes(1);
    await api('customers');
    const options = request.mock.calls[1][1] as RequestInit;
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer nuevo');
  });
  it('conserva mensajes y requestId y procesa respuestas vacías', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Permisos insuficientes', requestId: 'req1' }), {
            status: 403,
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    await expect(api('users')).rejects.toMatchObject({
      message: 'Permisos insuficientes',
      status: 403,
      requestId: 'req1',
    });
    expect(await api('auth/logout')).toBeUndefined();
  });
  it('no establece content-type JSON en archivos multipart', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', request);
    await api('imports/transactions', { method: 'POST', body: new FormData() });
    expect(new Headers(request.mock.calls[0][1].headers).get('Content-Type')).toBeNull();
  });
});
