import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../common/http/decorators';
import type { AuthUser } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { computeRfm, summarizeSegments, type RfmRow } from './rfm';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const rfmQuery = pageQuery.extend({
  segment: z
    .enum(['Champions', 'Loyal', 'Big Spenders', 'New', 'Promising', 'At Risk', 'Inactive'])
    .optional(),
});
const customersQuery = pageQuery.extend({ search: z.string().trim().max(100).optional() });
const cuid = z.string().regex(/^[a-z0-9]{20,40}$/);

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(orgId: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { currency: true },
    });
    const [totals, customers, monthly, repeat] = await Promise.all([
      this.prisma.transaction.aggregate({ where: { orgId }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.customer.count({ where: { orgId } }),
      this.prisma.$queryRaw<
        Array<{ month: Date; revenue: number; orders: number; customers: number }>
      >(Prisma.sql`
        SELECT date_trunc('month', "occurredAt") AS month, SUM(amount)::float AS revenue,
               COUNT(*)::int AS orders, COUNT(DISTINCT "customerId")::int AS customers
        FROM "Transaction" WHERE "orgId" = ${orgId}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
      this.prisma.$queryRaw<Array<{ buyers: number; repeaters: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS buyers, COUNT(*) FILTER (WHERE n >= 2)::int AS repeaters
        FROM (SELECT COUNT(*) AS n FROM "Transaction" WHERE "orgId" = ${orgId} GROUP BY "customerId") t`),
    ]);
    const revenue = Number(totals._sum.amount ?? 0);
    const orders = totals._count._all;
    const buyers = repeat[0]?.buyers ?? 0;
    return {
      currency: org.currency,
      revenue: Math.round(revenue * 100) / 100,
      orders,
      customers,
      avgTicket: orders ? Math.round((revenue / orders) * 100) / 100 : 0,
      repeatRate: buyers ? Math.round(((repeat[0]?.repeaters ?? 0) / buyers) * 1000) / 10 : 0,
      monthly: monthly.reverse().map((m) => ({
        month: m.month.toISOString().slice(0, 7),
        revenue: Math.round(m.revenue * 100) / 100,
        orders: m.orders,
        customers: m.customers,
      })),
    };
  }

  /** Agregados por cliente (R/F/M) calculados en BD y clasificados en memoria. */
  async rfm(orgId: string, asOf = new Date()): Promise<RfmRow[]> {
    const grouped = await this.prisma.transaction.groupBy({
      by: ['customerId'],
      where: { orgId },
      _max: { occurredAt: true },
      _count: { _all: true },
      _sum: { amount: true },
    });
    return computeRfm(
      grouped.map((g) => ({
        customerId: g.customerId,
        lastPurchaseAt: g._max.occurredAt as Date,
        frequency: g._count._all,
        monetary: Number(g._sum.amount ?? 0),
      })),
      asOf,
    );
  }

  async rfmReport(orgId: string, q: z.infer<typeof rfmQuery>) {
    const rows = await this.rfm(orgId);
    const filtered = (q.segment ? rows.filter((r) => r.segment === q.segment) : rows).sort(
      (a, b) => b.monetary - a.monetary,
    );
    const pageRows = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const customers = await this.prisma.customer.findMany({
      where: { orgId, id: { in: pageRows.map((r) => r.customerId) } },
      select: { id: true, name: true, externalId: true },
    });
    const byId = new Map(customers.map((c) => [c.id, c]));
    return {
      segments: summarizeSegments(rows),
      total: filtered.length,
      page: q.page,
      pageSize: q.pageSize,
      items: pageRows.map((r) => ({
        customerId: r.customerId,
        name: byId.get(r.customerId)?.name ?? '—',
        externalId: byId.get(r.customerId)?.externalId ?? '',
        recencyDays: r.recencyDays,
        frequency: r.frequency,
        monetary: Math.round(r.monetary * 100) / 100,
        r: r.r,
        f: r.f,
        m: r.m,
        segment: r.segment,
      })),
    };
  }

  async customers(orgId: string, q: z.infer<typeof customersQuery>) {
    const where: Prisma.CustomerWhereInput = {
      orgId,
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
              { externalId: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: { id: true, externalId: true, name: true, email: true, createdAt: true },
      }),
      this.prisma.customer.count({ where }),
    ]);
    const agg = await this.prisma.transaction.groupBy({
      by: ['customerId'],
      where: { orgId, customerId: { in: items.map((i) => i.id) } },
      _count: { _all: true },
      _sum: { amount: true },
      _max: { occurredAt: true },
    });
    const byId = new Map(agg.map((a) => [a.customerId, a]));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: items.map((c) => ({
        ...c,
        orders: byId.get(c.id)?._count._all ?? 0,
        revenue: Number(byId.get(c.id)?._sum.amount ?? 0),
        lastPurchaseAt: byId.get(c.id)?._max.occurredAt ?? null,
      })),
    };
  }

  async customerDetail(orgId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, orgId },
      select: {
        id: true,
        externalId: true,
        name: true,
        email: true,
        createdAt: true,
        transactions: {
          orderBy: { occurredAt: 'desc' },
          take: 20,
          select: { id: true, externalId: true, amount: true, currency: true, occurredAt: true },
        },
        predictions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            churnProbability: true,
            riskBand: true,
            explanation: true,
            modelVersion: true,
            createdAt: true,
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    return customer;
  }
}

@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('analytics/overview')
  overview(@CurrentUser() u: AuthUser) {
    return this.analytics.overview(u.orgId);
  }

  @Get('analytics/rfm')
  rfm(@CurrentUser() u: AuthUser, @Query(zod(rfmQuery)) q: z.infer<typeof rfmQuery>) {
    return this.analytics.rfmReport(u.orgId, q);
  }

  @Get('customers')
  customers(@CurrentUser() u: AuthUser, @Query(zod(customersQuery)) q: z.infer<typeof customersQuery>) {
    return this.analytics.customers(u.orgId, q);
  }

  @Get('customers/:id')
  customer(@CurrentUser() u: AuthUser, @Param('id', zod(cuid)) id: string) {
    return this.analytics.customerDetail(u.orgId, id);
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
