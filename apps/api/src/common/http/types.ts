import type { Request } from 'express';
import type { RoleName } from '../rbac';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: RoleName;
}

export interface AuthedRequest extends Request {
  user: AuthUser;
  requestId: string;
  rawBody?: Buffer;
}

export interface ClientInfo {
  ip: string;
  userAgent: string;
}

export function clientInfo(req: Request): ClientInfo {
  return { ip: req.ip ?? 'unknown', userAgent: String(req.headers['user-agent'] ?? '').slice(0, 255) };
}
