export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId?: string,
  ) {
    super(message);
  }
}
export interface User {
  id: string;
  name: string;
  email: string;
  orgId: string;
  orgName: string;
  role: 'OWNER' | 'ADMIN' | 'ANALYST' | 'VIEWER';
  currency?: string;
}
export interface Session {
  accessToken: string;
  user: User;
}
let token: string | null = null;
let refreshFlight: Promise<Session> | null = null;
let epoch = 0;
export function setToken(value: string | null) {
  token = value;
  if (value === null) epoch++;
}
async function decode<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({ message: 'Respuesta inválida del servidor' }));
  if (!response.ok)
    throw new ApiError(
      Array.isArray(body.message)
        ? body.message.join(', ')
        : (body.message ?? 'No se pudo completar la operación'),
      response.status,
      body.requestId,
    );
  return body as T;
}
export function refresh(): Promise<Session> {
  if (!refreshFlight) {
    const currentEpoch = epoch;
    refreshFlight = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(decode<Session>)
      .then((session) => {
        if (epoch === currentEpoch) token = session.accessToken;
        return session;
      })
      .finally(() => {
        refreshFlight = null;
      });
  }
  return refreshFlight;
}
export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/${path}`, { ...options, headers, credentials: 'include' });
  if (
    response.status === 401 &&
    retry &&
    !path.startsWith('auth/') &&
    !path.startsWith('security/training')
  ) {
    try {
      await refresh();
    } catch {
      token = null;
      window.dispatchEvent(new Event('session-expired'));
      throw new ApiError('Tu sesión ha caducado. Vuelve a iniciar sesión.', 401);
    }
    return api<T>(path, options, false);
  }
  return decode<T>(response);
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
