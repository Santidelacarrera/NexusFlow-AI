import { Body, Controller, Get, Injectable, Logger, Module, Post, Query } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Client, CurrentUser, Roles } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { TriggersService } from '../triggers/triggers.module';
import { computeOpsKpis, delayHours, isLate, simulateOrders } from './metrics';

const simulateSchema = z.object({ count: z.number().int().min(10).max(500).default(100) });
const listQuery = z.object({
  status: z.enum(['PENDING', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']).optional(),
  late: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@Injectable()
export class OperationsService {
  private readonly logger = new Logger('Operations');
  constructor(
    private readonly prisma: PrismaService,
    private readonly triggers: TriggersService,
    private readonly audit: AuditService,
  ) {}

  private loadOrders(orgId: string) {
    return this.prisma.order.findMany({ where: { orgId }, take: 20_000, orderBy: { createdAt: 'desc' } });
  }

  async kpis(orgId: string) {
    return computeOpsKpis(await this.loadOrders(orgId), new Date());
  }

  async list(orgId: string, q: z.infer<typeof listQuery>) {
    const now = new Date();
    const all = await this.loadOrders(orgId);
    const filtered = all
      .filter((o) => (q.status ? o.status === q.status : true))
      .filter((o) => (q.late ? isLate(o, now) === (q.late === 'true') : true));
    return {
      total: filtered.length,
      page: q.page,
      pageSize: q.pageSize,
      items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((o) => ({
        id: o.id,
        externalId: o.externalId,
        carrier: o.carrier,
        route: o.route,
        status: o.status,
        promisedAt: o.promisedAt,
        deliveredAt: o.deliveredAt,
        late: isLate(o, now),
        delayHours: isLate(o, now) ? delayHours(o, now) : 0,
      })),
    };
  }

  async simulate(user: AuthUser, count: number, client: ClientInfo) {
    const now = new Date();
    const prefix = `SIM-${now.getTime().toString(36).toUpperCase()}`;
    const orders = simulateOrders(count, now, now.getTime() % 1_000_000, prefix);
    const res = await this.prisma.order.createMany({
      data: orders.map((o) => ({ ...o, orgId: user.orgId })),
      skipDuplicates: true,
    });
    await this.audit.record({
      orgId: user.orgId,
      userId: user.id,
      action: 'operations.simulate',
      resource: 'order',
      client,
      metadata: { count: res.count },
    });
    const detected = await this.detectLate(user.orgId);
    return { created: res.count, ...detected };
  }

  /** Detecta pedidos en incumplimiento sin alerta previa, crea la alerta y dispara los workflows `trigger.late_order`. */
  async detectLate(orgId: string): Promise<{ newAlerts: number; workflowsFired: number }> {
    const now = new Date();
    const open = await this.prisma.order.findMany({
      where: { orgId, status: { in: ['PENDING', 'IN_TRANSIT'] }, promisedAt: { lt: now } },
      take: 500,
      orderBy: { promisedAt: 'asc' },
    });
    let newAlerts = 0;
    let fired = 0;
    for (const o of open) {
      if (newAlerts >= 50) break;
      const exists = await this.prisma.alert.findFirst({
        where: { orgId, source: 'operations', metadata: { path: ['orderId'], equals: o.id } },
        select: { id: true },
      });
      if (exists) continue;
      const hours = delayHours(o, now);
      const created = await this.prisma.alert.createMany({
        data: {
          orgId,
          dedupKey: `late:${o.id}`,
          source: 'operations',
          severity: hours > 24 ? 'CRITICAL' : 'WARNING',
          title: `Pedido ${o.externalId} fuera de plazo`,
          message: `El pedido ${o.externalId} (${o.carrier}, ruta ${o.route}) supera su promesa de entrega por ${hours} h.`,
          metadata: { orderId: o.id, carrier: o.carrier, delayHours: hours } as Prisma.InputJsonValue,
        },
        skipDuplicates: true,
      });
      if (!created.count) continue;
      newAlerts++;
      fired += await this.triggers.fire(orgId, 'trigger.late_order', {
        orderId: o.externalId,
        carrier: o.carrier,
        route: o.route,
        delayHours: hours,
      });
    }
    return { newAlerts, workflowsFired: fired };
  }

  @Cron('*/5 * * * *')
  async scheduledDetection(): Promise<void> {
    try {
      const orgs = await this.prisma.order.findMany({
        where: { status: { in: ['PENDING', 'IN_TRANSIT'] } },
        distinct: ['orgId'],
        select: { orgId: true },
        take: 200,
      });
      for (const { orgId } of orgs) await this.detectLate(orgId);
    } catch (e) {
      this.logger.error(`Detección programada falló: ${(e as Error).message}`);
    }
  }
}

@Controller('operations')
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

  @Get('kpis')
  kpis(@CurrentUser() u: AuthUser) {
    return this.ops.kpis(u.orgId);
  }

  @Get('orders')
  orders(@CurrentUser() u: AuthUser, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.ops.list(u.orgId, q);
  }

  @Roles('ANALYST')
  @Post('simulate')
  simulate(
    @CurrentUser() u: AuthUser,
    @Body(zod(simulateSchema)) dto: z.infer<typeof simulateSchema>,
    @Client() c: ClientInfo,
  ) {
    return this.ops.simulate(u, dto.count, c);
  }

  @Roles('ANALYST')
  @Post('detect')
  detect(@CurrentUser() u: AuthUser) {
    return this.ops.detectLate(u.orgId);
  }
}

@Module({ controllers: [OperationsController], providers: [OperationsService], exports: [OperationsService] })
export class OperationsModule {}
