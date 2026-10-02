import { classify, computeRfm, quintileScores, summarizeSegments } from './rfm';

describe('quintileScores', () => {
  it('reparte 1..5 en 10 valores distintos', () => {
    const s = quintileScores([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
  it('invierte la escala para recencia', () => {
    expect(quintileScores([1, 2, 3, 4, 5], false)).toEqual([5, 4, 3, 2, 1]);
  });
  it('los empates reciben la misma nota y un conjunto uniforme es neutro', () => {
    expect(quintileScores([7, 7, 7, 7])).toEqual([3, 3, 3, 3]);
    const s = quintileScores([1, 1, 9]);
    expect(s[0]).toBe(s[1]);
    expect(s[2]).toBeGreaterThan(s[0]);
  });
  it('vacío', () => expect(quintileScores([])).toEqual([]));
});

describe('classify', () => {
  it.each([
    [5, 5, 5, 'Champions'],
    [4, 4, 1, 'Champions'],
    [1, 4, 5, 'At Risk'],
    [3, 5, 2, 'Loyal'],
    [3, 2, 5, 'Big Spenders'],
    [5, 1, 1, 'New'],
    [1, 1, 1, 'Inactive'],
    [3, 3, 3, 'Promising'],
  ])('R%i F%i M%i -> %s', (r, f, m, seg) => expect(classify(r, f, m)).toBe(seg));
});

describe('computeRfm', () => {
  const asOf = new Date('2026-01-31T00:00:00Z');
  const mk = (id: string, daysAgo: number, frequency: number, monetary: number) => ({
    customerId: id,
    lastPurchaseAt: new Date(asOf.getTime() - daysAgo * 86_400_000),
    frequency,
    monetary,
  });
  it('segmenta clientes coherentemente', () => {
    const data = [
      mk('champ', 1, 30, 9000),
      mk('a', 10, 12, 3000),
      mk('b', 30, 8, 2000),
      mk('c', 60, 5, 900),
      mk('d', 90, 3, 400),
      mk('new', 2, 1, 50),
      mk('e', 120, 2, 120),
      mk('f', 200, 1, 40),
      mk('gone', 400, 6, 800),
      mk('h', 45, 4, 600),
    ];
    const rows = computeRfm(data, asOf);
    const seg = Object.fromEntries(rows.map((r) => [r.customerId, r.segment]));
    expect(seg.champ).toBe('Champions');
    expect(seg.gone).toMatch(/At Risk|Inactive/);
    expect(seg.f).toBe('Inactive');
    expect(rows.find((r) => r.customerId === 'champ')).toMatchObject({ r: 5, f: 5, m: 5, recencyDays: 1 });
  });
  it('resume por segmento ordenando por ingresos', () => {
    const rows = computeRfm([mk('x', 1, 10, 100), mk('y', 300, 1, 5)], asOf);
    const sum = summarizeSegments(rows);
    expect(sum.reduce((a, s) => a + s.customers, 0)).toBe(2);
    expect(sum[0].revenue).toBeGreaterThanOrEqual(sum[1].revenue);
  });
});
