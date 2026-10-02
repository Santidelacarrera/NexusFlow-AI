export interface CustomerAggregate {
  customerId: string;
  lastPurchaseAt: Date;
  frequency: number;
  monetary: number;
}

export type Segment = 'Champions' | 'Loyal' | 'Big Spenders' | 'New' | 'Promising' | 'At Risk' | 'Inactive';

export interface RfmRow extends CustomerAggregate {
  recencyDays: number;
  r: number;
  f: number;
  m: number;
  segment: Segment;
}

const DAY_MS = 86_400_000;

/**
 * Puntuación 1..5 por rango percentil con tratamiento de empates (los valores iguales reciben la misma nota).
 * `higherIsBetter=false` invierte la escala (p. ej. recencia: menos días = mejor).
 */
export function quintileScores(values: number[], higherIsBetter = true): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const lowerCount = new Map<number, number>();
  const equalCount = new Map<number, number>();
  sorted.forEach((v, i) => {
    if (!lowerCount.has(v)) lowerCount.set(v, i);
    equalCount.set(v, (equalCount.get(v) ?? 0) + 1);
  });
  return values.map((v) => {
    const pct = ((lowerCount.get(v) as number) + 0.5 * (equalCount.get(v) as number)) / n;
    const score = Math.min(5, Math.floor(pct * 5) + 1);
    return higherIsBetter ? score : 6 - score;
  });
}

/** Reglas ordenadas por prioridad; documentadas en docs/ARCHITECTURE.md. */
export function classify(r: number, f: number, m: number): Segment {
  if (r >= 4 && f >= 4) return 'Champions';
  if (r <= 2 && f >= 3) return 'At Risk';
  if (f >= 4 && r >= 3) return 'Loyal';
  if (m >= 4 && r >= 3) return 'Big Spenders';
  if (r >= 4 && f <= 2) return 'New';
  if (r <= 2) return 'Inactive';
  return 'Promising';
}

export function computeRfm(customers: CustomerAggregate[], asOf: Date): RfmRow[] {
  const recency = customers.map((c) =>
    Math.max(0, Math.floor((asOf.getTime() - c.lastPurchaseAt.getTime()) / DAY_MS)),
  );
  const rs = quintileScores(recency, false);
  const fs = quintileScores(customers.map((c) => c.frequency));
  const ms = quintileScores(customers.map((c) => c.monetary));
  return customers.map((c, i) => ({
    ...c,
    recencyDays: recency[i],
    r: rs[i],
    f: fs[i],
    m: ms[i],
    segment: classify(rs[i], fs[i], ms[i]),
  }));
}

export function summarizeSegments(
  rows: RfmRow[],
): Array<{ segment: Segment; customers: number; revenue: number }> {
  const acc = new Map<Segment, { customers: number; revenue: number }>();
  for (const r of rows) {
    const cur = acc.get(r.segment) ?? { customers: 0, revenue: 0 };
    cur.customers += 1;
    cur.revenue += r.monetary;
    acc.set(r.segment, cur);
  }
  return [...acc.entries()]
    .map(([segment, v]) => ({ segment, customers: v.customers, revenue: Math.round(v.revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);
}
