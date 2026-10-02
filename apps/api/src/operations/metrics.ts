export interface OrderLike {
  externalId: string;
  carrier: string;
  status: 'PENDING' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED';
  promisedAt: Date;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
}

const HOUR_MS = 3_600_000;

/** Un pedido está en incumplimiento si se entregó tarde, o sigue abierto y ya venció su promesa. */
export function isLate(o: OrderLike, now: Date): boolean {
  if (o.status === 'CANCELLED') return false;
  if (o.status === 'DELIVERED' && o.deliveredAt) return o.deliveredAt.getTime() > o.promisedAt.getTime();
  return now.getTime() > o.promisedAt.getTime();
}

export function delayHours(o: OrderLike, now: Date): number {
  const end = o.deliveredAt ?? now;
  return Math.max(0, Math.round(((end.getTime() - o.promisedAt.getTime()) / HOUR_MS) * 10) / 10);
}

export interface OpsKpis {
  total: number;
  delivered: number;
  inTransit: number;
  late: number;
  onTimeRate: number | null;
  avgDeliveryHours: number | null;
  byCarrier: Array<{ carrier: string; total: number; late: number; onTimeRate: number | null }>;
}

export function computeOpsKpis(orders: OrderLike[], now: Date): OpsKpis {
  const active = orders.filter((o) => o.status !== 'CANCELLED');
  const delivered = active.filter((o) => o.status === 'DELIVERED' && o.deliveredAt);
  const deliveredOnTime = delivered.filter((o) => !isLate(o, now)).length;
  const durations = delivered
    .filter((o) => o.dispatchedAt)
    .map((o) => ((o.deliveredAt as Date).getTime() - (o.dispatchedAt as Date).getTime()) / HOUR_MS);

  const carriers = new Map<
    string,
    { total: number; late: number; deliveredTotal: number; deliveredOnTime: number }
  >();
  for (const o of active) {
    const c = carriers.get(o.carrier) ?? { total: 0, late: 0, deliveredTotal: 0, deliveredOnTime: 0 };
    c.total++;
    const late = isLate(o, now);
    if (late) c.late++;
    if (o.status === 'DELIVERED') {
      c.deliveredTotal++;
      if (!late) c.deliveredOnTime++;
    }
    carriers.set(o.carrier, c);
  }
  const rate = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);

  return {
    total: active.length,
    delivered: delivered.length,
    inTransit: active.filter((o) => o.status === 'IN_TRANSIT').length,
    late: active.filter((o) => isLate(o, now)).length,
    onTimeRate: rate(deliveredOnTime, delivered.length),
    avgDeliveryHours: durations.length
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null,
    byCarrier: [...carriers.entries()]
      .map(([carrier, c]) => ({
        carrier,
        total: c.total,
        late: c.late,
        onTimeRate: rate(c.deliveredOnTime, c.deliveredTotal),
      }))
      .sort((a, b) => b.late - a.late),
  };
}

/** PRNG determinista (mulberry32) para simulaciones reproducibles. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatedOrder {
  externalId: string;
  customerRef: string;
  carrier: string;
  route: string;
  status: OrderLike['status'];
  createdAt: Date;
  promisedAt: Date;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
}

const CARRIERS = ['AndesExpress', 'RutaSur', 'FastCargo', 'LogiNorte'];
const ROUTES = ['BUE-COR', 'BUE-ROS', 'COR-MZA', 'ROS-TUC', 'BUE-MDP', 'MZA-SJU'];

/** Genera pedidos sintéticos (v1 de Operations Intelligence: telemetría simulada). */
export function simulateOrders(count: number, now: Date, seed: number, prefix: string): SimulatedOrder[] {
  const rand = rng(seed);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const out: SimulatedOrder[] = [];
  for (let i = 0; i < count; i++) {
    const ageH = rand() * 24 * 10;
    const createdAt = new Date(now.getTime() - ageH * HOUR_MS);
    const promisedAt = new Date(createdAt.getTime() + (24 + Math.floor(rand() * 48)) * HOUR_MS);
    const carrier = pick(CARRIERS);
    const slow = carrier === 'RutaSur' ? 0.35 : 0.12;
    const roll = rand();
    const dispatchedAt = new Date(createdAt.getTime() + (2 + rand() * 6) * HOUR_MS);
    let status: OrderLike['status'] = 'PENDING';
    let deliveredAt: Date | null = null;
    let dispatched: Date | null = null;
    if (roll < 0.03) status = 'CANCELLED';
    else if (dispatchedAt <= now) {
      dispatched = dispatchedAt;
      const transit = (12 + rand() * 40 + (rand() < slow ? 30 : 0)) * HOUR_MS;
      const arrival = new Date(dispatchedAt.getTime() + transit);
      if (arrival <= now) {
        status = 'DELIVERED';
        deliveredAt = arrival;
      } else status = 'IN_TRANSIT';
    }
    out.push({
      externalId: `${prefix}-${String(i + 1).padStart(5, '0')}`,
      customerRef: `C-${1000 + Math.floor(rand() * 400)}`,
      carrier,
      route: pick(ROUTES),
      status,
      createdAt,
      promisedAt,
      dispatchedAt: dispatched,
      deliveredAt,
    });
  }
  return out;
}
