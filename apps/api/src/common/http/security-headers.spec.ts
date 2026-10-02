import type { Request, Response } from 'express';
import { apiSecurityHeaders } from './security-headers';

function run(path: string) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => void (headers[k] = v) } as unknown as Response;
  const next = jest.fn();
  apiSecurityHeaders({ path } as Request, res, next);
  return { headers, next };
}

describe('apiSecurityHeaders', () => {
  it('impide el cacheo y aísla las respuestas', () => {
    const { headers, next } = run('/api/customers');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
