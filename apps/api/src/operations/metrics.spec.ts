import { computeOpsKpis, delayHours, isLate, simulateOrders, type OrderLike } from './metrics';

const now = new Date('2026-02-10T12:00:00Z');
const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
const order = (over: Partial<OrderLike>): OrderLike => ({
  externalId: 'x', carrier: 'A', status: 'PENDING', promisedAt: h(1), dispatchedAt: null, deliveredAt: null, ...over,
});

describe('operations metrics', () => {
  it('detecta incumplimientos', () => {
    expect(isLate(order({ status: 'IN_TRANSIT', promisedAt: h(-2) }), now)).toBe(true);
    expect(isLate(order({ status: 'IN_TRANSIT', promisedAt: h(2) }), now)).toBe(false);
    expect(isLate(order({ status: 'DELIVERED', promisedAt: h(-5), deliveredAt: h(-6) }), now)).toBe(false);
    expect(isLate(order({ status: 'DELIVERED', promisedAt: h(-5), deliveredAt: h(-4) }), now)).toBe(true);
    expect(isLate(order({ status: 'CANCELLED', promisedAt: h(-50) }), now)).toBe(false);
  });
  it('calcula horas de retraso', () => {
    expect(delayHours(order({ promisedAt: h(-3) }), now)).toBe(3);
    expect(delayHours(order({ promisedAt: h(3) }), now)).toBe(0);
  });
  it('calcula KPIs y agrupa por transportista', () => {
    const k = computeOpsKpis(
      [
        order({ carrier: 'A', status: 'DELIVERED', promisedAt: h(-10), dispatchedAt: h(-30), deliveredAt: h(-12) }),
        order({ carrier: 'A', status: 'DELIVERED', promisedAt: h(-10), dispatchedAt: h(-30), deliveredAt: h(-5) }),
        order({ carrier: 'B', status: 'IN_TRANSIT', promisedAt: h(-1) }),
        order({ carrier: 'B', status: 'CANCELLED' }),
      ],
      now,
    );
    expect(k).toMatchObject({ total: 3, delivered: 2, inTransit: 1, late: 2, onTimeRate: 50 });
    expect(k.avgDeliveryHours).toBe(21.5);
    expect(k.byCarrier.find((c) => c.carrier === 'A')).toMatchObject({ total: 2, late: 1, onTimeRate: 50 });
  });
  it('sin datos devuelve nulls y no divide por cero', () => {
    expect(computeOpsKpis([], now)).toMatchObject({ total: 0, onTimeRate: null, avgDeliveryHours: null });
  });
  it('la simulación es determinista y coherente', () => {
    const a = simulateOrders(200, now, 42, 'SIM');
    const b = simulateOrders(200, now, 42, 'SIM');
    expect(a).toEqual(b);
    expect(new Set(a.map((o) => o.externalId)).size).toBe(200);
    for (const o of a) {
      if (o.status === 'DELIVERED') expect(o.deliveredAt).not.toBeNull();
      if (o.deliveredAt) expect(o.deliveredAt.getTime()).toBeLessThanOrEqual(now.getTime());
    }
    expect(a.some((o) => o.status === 'DELIVERED')).toBe(true);
  });
});
