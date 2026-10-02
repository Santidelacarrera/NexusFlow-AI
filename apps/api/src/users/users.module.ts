import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Client, CurrentUser, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { checkPasswordPolicy, hashPassword } from '../common/security/password';
import { canManage, ROLES, type RoleName } from '../common/rbac';
import { PrismaService } from '../prisma/prisma.service';

const email = z.string().trim().toLowerCase().email().max(254);
const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email,
  password: z.string().max(128),
  role: z.enum(ROLES).default('VIEWER'),
});
const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
});
const resetSchema = z.object({ password: z.string().max(128) });
const cuid = z.string().regex(/^[a-z0-9]{20,40}$/);

const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(orgId: string) {
    return this.prisma.user.findMany({
      where: { orgId },
      select: SAFE_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  async create(actor: AuthUser, dto: z.infer<typeof createSchema>, client: ClientInfo) {
    if (!canManage(actor.role, 'VIEWER', dto.role, false))
      throw new ForbiddenException('No puedes asignar ese rol');
    const policy = checkPasswordPolicy(dto.password, { email: dto.email, name: dto.name });
    if (!policy.ok) throw new BadRequestException(policy.reason);
    if (await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } }))
      throw new ConflictException('El email ya está registrado');
    const user = await this.prisma.user.create({
      data: {
        orgId: actor.orgId,
        email: dto.email,
        name: dto.name,
        role: dto.role,
        passwordHash: await hashPassword(dto.password),
      },
      select: SAFE_SELECT,
    });
    await this.audit.record({
      orgId: actor.orgId,
      userId: actor.id,
      action: 'user.create',
      resource: 'user',
      resourceId: user.id,
      client,
      metadata: { role: dto.role },
    });
    return user;
  }

  /** El orgId siempre sale de la sesión: un admin jamás puede tocar usuarios de otra organización. */
  private async findInOrg(actor: AuthUser, id: string) {
    const target = await this.prisma.user.findFirst({ where: { id, orgId: actor.orgId } });
    if (!target) throw new NotFoundException('Usuario no encontrado');
    return target;
  }

  private async assertNotLastOwner(orgId: string, target: { id: string; role: RoleName }) {
    if (target.role !== 'OWNER') return;
    const owners = await this.prisma.user.count({ where: { orgId, role: 'OWNER', isActive: true } });
    if (owners <= 1) throw new BadRequestException('La organización debe conservar al menos un OWNER activo');
  }

  async update(actor: AuthUser, id: string, dto: z.infer<typeof updateSchema>, client: ClientInfo) {
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId + ':users'}))`;
      const target = await tx.user.findFirst({ where: { id, orgId: actor.orgId } });
      if (!target) throw new NotFoundException('Usuario no encontrado');
      const self = target.id === actor.id;
      if (self && dto.isActive === false)
        throw new BadRequestException('No puedes desactivar tu propia cuenta');
      if (!canManage(actor.role, target.role, dto.role, self))
        throw new ForbiddenException('Permisos insuficientes para esta operación');
      if (target.role === 'OWNER' && (dto.isActive === false || (dto.role && dto.role !== 'OWNER'))) {
        const owners = await tx.user.count({ where: { orgId: actor.orgId, role: 'OWNER', isActive: true } });
        if (owners <= 1)
          throw new BadRequestException('La organización debe conservar al menos un OWNER activo');
      }
      const updated = await tx.user.update({ where: { id }, data: dto, select: SAFE_SELECT });
      if (dto.isActive === false || (dto.role && dto.role !== target.role))
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      return updated;
    });
    await this.audit.record({
      orgId: actor.orgId,
      userId: actor.id,
      action: 'user.update',
      resource: 'user',
      resourceId: id,
      client,
      metadata: { changes: dto },
    });
    return user;
  }

  async resetPassword(actor: AuthUser, id: string, password: string, client: ClientInfo) {
    const target = await this.findInOrg(actor, id);
    if (target.id !== actor.id && !canManage(actor.role, target.role, undefined, false))
      throw new ForbiddenException('Permisos insuficientes para esta operación');
    const policy = checkPasswordPolicy(password, { email: target.email, name: target.name });
    if (!policy.ok) throw new BadRequestException(policy.reason);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      orgId: actor.orgId,
      userId: actor.id,
      action: 'user.password_reset',
      resource: 'user',
      resourceId: id,
      client,
    });
  }

  async revokeSessions(actor: AuthUser, id: string, client: ClientInfo) {
    const target = await this.findInOrg(actor, id);
    if (target.id !== actor.id && !canManage(actor.role, target.role, undefined, false))
      throw new ForbiddenException('Permisos insuficientes para esta operación');
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      orgId: actor.orgId,
      userId: actor.id,
      action: 'user.sessions_revoked',
      resource: 'user',
      resourceId: id,
      client,
    });
  }
}

@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.users.list(u.orgId);
  }

  @Post()
  create(
    @CurrentUser() u: AuthUser,
    @Body(zod(createSchema)) dto: z.infer<typeof createSchema>,
    @Client() c: ClientInfo,
  ) {
    return this.users.create(u, dto, c);
  }

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(cuid)) id: string,
    @Body(zod(updateSchema)) dto: z.infer<typeof updateSchema>,
    @Client() c: ClientInfo,
  ) {
    return this.users.update(u, id, dto, c);
  }

  @HttpCode(204)
  @Post(':id/password')
  async reset(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(cuid)) id: string,
    @Body(zod(resetSchema)) dto: z.infer<typeof resetSchema>,
    @Client() c: ClientInfo,
  ) {
    await this.users.resetPassword(u, id, dto.password, c);
  }

  @HttpCode(204)
  @Post(':id/revoke-sessions')
  async revoke(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string, @Client() c: ClientInfo) {
    await this.users.revokeSessions(u, id, c);
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
