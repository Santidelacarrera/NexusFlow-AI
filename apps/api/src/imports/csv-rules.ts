import { sanitizeCell } from '../common/security/csv-sanitize';

export interface ValidTransactionRow {
  customerExternalId: string;
  customerName: string;
  email: string | null;
  transactionId: string;
  amount: number;
  currency: string;
  occurredAt: Date;
}

export type RowResult = { ok: true; value: ValidTransactionRow } | { ok: false; errors: string[] };

const ALIASES: Record<string, string> = {
  customer_id: 'customer_id',
  customerid: 'customer_id',
  cliente_id: 'customer_id',
  customer_name: 'customer_name',
  name: 'customer_name',
  nombre: 'customer_name',
  cliente: 'customer_name',
  email: 'email',
  correo: 'email',
  transaction_id: 'transaction_id',
  order_id: 'transaction_id',
  transaccion_id: 'transaction_id',
  id_transaccion: 'transaction_id',
  amount: 'amount',
  monto: 'amount',
  total: 'amount',
  currency: 'currency',
  moneda: 'currency',
  date: 'date',
  fecha: 'date',
  occurred_at: 'date',
  order_date: 'date',
};

export const REQUIRED_COLUMNS = ['customer_id', 'transaction_id', 'amount', 'date'] as const;

export function normalizeHeader(h: string): string {
  const key = h
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return ALIASES[key] ?? key;
}

const ID_RE = /^[\w.@:/-]{1,100}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Parsea importes "1234.56" y "1.234,56"/"1,234.56"; rechaza notación científica y basura. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s$€£]/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function validateRow(raw: Record<string, string | undefined>, now: Date): RowResult {
  const errors: string[] = [];
  const get = (k: string) => (raw[k] ?? '').toString();

  const customerExternalId = sanitizeCell(get('customer_id'));
  if (!ID_RE.test(customerExternalId)) errors.push('customer_id inválido');
  const transactionId = sanitizeCell(get('transaction_id'));
  if (!ID_RE.test(transactionId)) errors.push('transaction_id inválido');

  const amount = parseAmount(get('amount'));
  if (amount === null) errors.push('amount no es un número válido');
  else if (amount <= 0) errors.push('amount debe ser mayor que 0');
  else if (amount > 100_000_000) errors.push('amount fuera de rango');

  const dateRaw = get('date').trim();
  const occurredAt = new Date(dateRaw);
  if (!dateRaw || Number.isNaN(occurredAt.getTime()))
    errors.push('date inválida (use ISO 8601, p. ej. 2026-01-31)');
  else if (occurredAt.getTime() > now.getTime() + 86_400_000) errors.push('date en el futuro');
  else if (occurredAt.getUTCFullYear() < 2000) errors.push('date anterior a 2000');

  const currency = get('currency').trim().toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('currency debe ser un código ISO de 3 letras');

  const emailRaw = sanitizeCell(get('email')).toLowerCase();
  if (emailRaw && !EMAIL_RE.test(emailRaw)) errors.push('email inválido');

  const name = sanitizeCell(get('customer_name')).slice(0, 120) || customerExternalId;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      customerExternalId,
      customerName: name,
      email: emailRaw || null,
      transactionId,
      amount: amount as number,
      currency,
      occurredAt,
    },
  };
}
