import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { getEnv } from '../common/config/env';
import type { ClientInfo } from '../common/http/types';
import { randomToken, sha256Hex } from '../common/security/crypto';
import { signAccessToken } from '../common/security/jwt';
import { checkPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from '../common/security/password';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

const email = z.string().trim().toLowerCase().email().max(254);
export const registerSchema = z.object({
  orgName: z.string().trim().min(2).max(100),
  currency: z.enum(['USD', 'CLP', 'EUR']).default('USD'),
  name: z.string().trim().min(2).max(100),
  email,
  password: z.string().max(128),
});
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const changePasswordSchema = z.object({
  currentPassword: z.string().max(128),
  newPassword: z.string().max(128),
});

export interface SessionResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; email: string; name: string; role: string; orgId: string; orgName: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async register(dto: z.infer<typeof registerSchema>, client: ClientInfo): Promise<SessionResult> {
    if (!getEnv().ALLOW_REGISTRATION) throw new ForbiddenException('El registro está deshabilitado');
    const policy = checkPasswordPolicy(dto.password, { email: dto.email, name: dto.name });
    if (!policy.ok) throw new BadRequestException(policy.reason);
    if (await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } })) {
      throw new ConflictException('No se pudo completar el registro con esos datos');
    }
    const passwordHash = await hashPassword(dto.password);
    const org = await this.prisma.organization.create({
      data: {
        name: dto.orgName,
        currency: dto.currency,
        users: { create: { email: dto.email, name: dto.name, passwordHash, role: 'OWNER' } },
      },
      include: { users: true },
    });
    const user = org.users[0];
    await this.audit.record({
      orgId: org.id,
      userId: user.id,
      action: 'auth.register',
      resource: 'organization',
      resourceId: org.id,
      client,
    });
    return this.issueSession({ ...user, orgName: org.name }, client);
  }

  async login(dto: z.infer<typeof loginSchema>, client: ClientInfo): Promise<SessionResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { org: { select: { name: true } } },
    });
    if (!user) {
      await dummyVerify(dto.password); // iguala tiempos: no se puede enumerar usuarios
      throw new UnauthorizedException('Credenciales inválidas');
    }
    const locked = user.lockedUntil && user.lockedUntil > new Date();
    const valid = await verifyPassword(dto.password, user.passwordHash);

    if (locked || !user.isActive) {
      await this.audit.record({
        orgId: user.orgId,
        userId: user.id,
        action: 'auth.login.blocked',
        client,
        metadata: { locked: !!locked, inactive: !user.isActive },
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }
    if (!valid) {
      const incremented = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });
      const failed = incremented.failedLogins;
      const lock = failed >= MAX_FAILED_LOGINS;
      if (lock)
        await this.prisma.user.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) },
        });
      await this.audit.record({
        orgId: user.orgId,
        userId: user.id,
        action: lock ? 'auth.account.locked' : 'auth.login.failed',
        client,
        metadata: { attempt: failed },
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ orgId: user.orgId, userId: user.id, action: 'auth.login', client });
    return this.issueSession({ ...user, orgName: user.org.name }, client);
  }

  /** Rotación de refresh tokens con detección de reutilización: reusar un token ya rotado revoca toda la familia. */
  async refresh(rawToken: string | undefined, client: ClientInfo): Promise<SessionResult> {
    if (!rawToken || rawToken.length > 200) throw new UnauthorizedException();
    const tokenHash = sha256Hex(rawToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { org: { select: { name: true } } } } },
    });
    if (!stored) throw new UnauthorizedException();

    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        orgId: stored.user.orgId,
        userId: stored.userId,
        action: 'auth.refresh.reuse_detected',
        client,
        metadata: { familyId: stored.familyId },
      });
      throw new UnauthorizedException();
    }
    if (stored.expiresAt < new Date() || !stored.user.isActive) throw new UnauthorizedException();

    // Revocación atómica: si dos peticiones concurrentes usan el mismo token, solo una gana.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw new UnauthorizedException();
    return this.issueSession({ ...stored.user, orgName: stored.user.org.name }, client, stored.familyId);
  }

  async logout(rawToken: string | undefined, client: ClientInfo): Promise<void> {
    if (!rawToken) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      include: { user: { select: { orgId: true } } },
    });
    if (!stored) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      orgId: stored.user.orgId,
      userId: stored.userId,
      action: 'auth.logout',
      client,
    });
  }

  async logoutAll(userId: string, orgId: string, client: ClientInfo): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ orgId, userId, action: 'auth.logout_all', client });
  }

  async changePassword(
    userId: string,
    dto: z.infer<typeof changePasswordSchema>,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      await this.audit.record({ orgId: user.orgId, userId, action: 'auth.password.change_failed', client });
      throw new UnauthorizedException('Credenciales inválidas');
    }
    const policy = checkPasswordPolicy(dto.newPassword, { email: user.email, name: user.name });
    if (!policy.ok) throw new BadRequestException(policy.reason);
    if (await verifyPassword(dto.newPassword, user.passwordHash))
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(dto.newPassword) },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit.record({ orgId: user.orgId, userId, action: 'auth.password.changed', client });
  }

  async purgeExpiredTokens(): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const res = await this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    return res.count;
  }

  private async issueSession(
    user: { id: string; orgId: string; email: string; name: string; role: string; orgName: string },
    client: ClientInfo,
    familyId = randomToken(16),
  ): Promise<SessionResult> {
    const refreshToken = randomToken(48);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: client.userAgent,
        ip: client.ip,
      },
    });
    return {
      accessToken: signAccessToken(
        user.id,
        user.orgId,
        getEnv().JWT_ACCESS_SECRET,
        ACCESS_TTL_SECONDS,
        Date.now(),
        familyId,
      ),
      expiresIn: ACCESS_TTL_SECONDS,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
        orgName: user.orgName,
      },
    };
  }
}
