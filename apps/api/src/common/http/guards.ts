import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getEnv } from '../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { verifyAccessToken } from '../security/jwt';
import { hasRole, RoleName } from '../rbac';
import { IS_PUBLIC, ROLE_KEY } from './decorators';
import type { AuthedRequest } from './types';

/**
 * Guard global de autenticación. Además de validar el JWT, consulta el usuario en BD en cada petición:
 * desactivar una cuenta o cambiar su rol surte efecto de inmediato (sin esperar a que expire el token).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    const claims = verifyAccessToken(header.slice(7), getEnv().JWT_ACCESS_SECRET);
    if (!claims) throw new UnauthorizedException();
    if (!claims.sid) throw new UnauthorizedException();
    const session = await this.prisma.refreshToken.findFirst({
      where: { userId: claims.sub, familyId: claims.sid, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!session) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, orgId: true, email: true, name: true, role: true, isActive: true },
    });
    if (!user || !user.isActive || user.orgId !== claims.org) throw new UnauthorizedException();
    req.user = { id: user.id, orgId: user.orgId, email: user.email, name: user.name, role: user.role };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const minimum = this.reflector.getAllAndOverride<RoleName | undefined>(ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!minimum) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user || !hasRole(req.user.role, minimum)) throw new ForbiddenException('Permisos insuficientes');
    return true;
  }
}
