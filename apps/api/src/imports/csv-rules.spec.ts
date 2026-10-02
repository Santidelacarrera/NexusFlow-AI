import { normalizeHeader, parseAmount, validateRow } from './csv-rules';

const now = new Date('2026-02-01T00:00:00Z');
const base = {
  customer_id: 'C1',
  transaction_id: 'T1',
  amount: '120.50',
  date: '2026-01-15',
  currency: 'usd',
  email: 'A@B.com',
  customer_name: 'Ana',
};

describe('csv-rules', () => {
  it('normaliza cabeceras y alias (incluye BOM)', () => {
    expect(normalizeHeader('﻿Customer ID')).toBe('customer_id');
    expect(normalizeHeader('Monto')).toBe('amount');
    expect(normalizeHeader('Order-Date')).toBe('date');
  });
  it.each([
    ['1234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['$ 99', 99],
    ['-5', -5],
    ['1e9', null],
    ['abc', null],
    ['', null],
  ])('parseAmount(%s)', (raw, expected) => expect(parseAmount(raw)).toBe(expected));

  it('acepta una fila válida y normaliza', () => {
    const r = validateRow(base, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ currency: 'USD', email: 'a@b.com', amount: 120.5 });
  });
  it('rechaza importes, fechas y monedas inválidas', () => {
    expect(validateRow({ ...base, amount: '0' }, now).ok).toBe(false);
    expect(validateRow({ ...base, amount: '-3' }, now).ok).toBe(false);
    expect(validateRow({ ...base, date: '2027-01-01' }, now).ok).toBe(false);
    expect(validateRow({ ...base, date: 'ayer' }, now).ok).toBe(false);
    expect(validateRow({ ...base, currency: 'DOLLARS' }, now).ok).toBe(false);
    expect(validateRow({ ...base, email: 'no-email' }, now).ok).toBe(false);
    expect(validateRow({ ...base, customer_id: '' }, now).ok).toBe(false);
  });
  it('neutraliza inyección de fórmulas en nombre y rechaza ids con caracteres peligrosos', () => {
    const r = validateRow({ ...base, customer_name: '=HYPERLINK("http://evil","x")' }, now);
    expect(r.ok && r.value.customerName.startsWith("'=")).toBe(true);
    expect(validateRow({ ...base, customer_id: '=1+1' }, now).ok).toBe(false);
    expect(validateRow({ ...base, transaction_id: "x'; DROP TABLE users;--" }, now).ok).toBe(false);
  });
});
