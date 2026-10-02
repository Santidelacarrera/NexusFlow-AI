import type { NextFunction, Request, Response } from 'express';

/**
 * Cabeceras adicionales a helmet para una API JSON pura:
 * - no-store: ninguna respuesta autenticada se cachea en navegador, proxy o CDN.
 * - CSP `default-src 'none'`: si una respuesta llegara a renderizarse, no puede cargar ni ejecutar nada.
 * - CORP/COOP same-origin: aísla el recurso frente a lecturas cross-origin (Spectre-class).
 */
export function apiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  next();
}
