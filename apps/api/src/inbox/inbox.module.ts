import { Body, Controller, Get, Module, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Client, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';

const paging = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const idSchema = z.string().regex(/^[a-z0-9]{20,40}$/);
const alertBody = z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']) });
const taskBody = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE']) });

@Controller()
class InboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}
  @Get('alerts') async alerts(@CurrentUser() u: AuthUser, @Query(zod(paging)) q: z.infer<typeof paging>) {
    const where = { orgId: u.orgId };
    const [items, total] = await Promise.all([
      this.prisma.alert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.alert.count({ where }),
    ]);
    return { items, total, ...q };
  }
  @Get('tasks') async tasks(@CurrentUser() u: AuthUser, @Query(zod(paging)) q: z.infer<typeof paging>) {
    const where = { orgId: u.orgId };
    const [items, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.task.count({ where }),
    ]);
    return { items, total, ...q };
  }
  @Roles('ANALYST') @Patch('alerts/:id') async alert(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(idSchema)) id: string,
    @Body(zod(alertBody)) dto: z.infer<typeof alertBody>,
    @Client() c: ClientInfo,
  ) {
    const r = await this.prisma.alert.updateMany({ where: { id, orgId: u.orgId }, data: dto });
    if (!r.count) throw new NotFoundException();
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'alert.update',
      resourceId: id,
      metadata: dto,
      client: c,
    });
    return { id, ...dto };
  }
  @Roles('ANALYST') @Patch('tasks/:id') async task(
    @CurrentUser() u: AuthUser,
    @Param('id', zod(idSchema)) id: string,
    @Body(zod(taskBody)) dto: z.infer<typeof taskBody>,
    @Client() c: ClientInfo,
  ) {
    const r = await this.prisma.task.updateMany({ where: { id, orgId: u.orgId }, data: dto });
    if (!r.count) throw new NotFoundException();
    await this.audit.record({
      orgId: u.orgId,
      userId: u.id,
      action: 'task.update',
      resourceId: id,
      metadata: dto,
      client: c,
    });
    return { id, ...dto };
  }
}
@Module({ controllers: [InboxController] })
export class InboxModule {}
