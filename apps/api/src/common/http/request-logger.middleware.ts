import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from './types';

const logger = new Logger('HTTP');

/** Asigna un requestId, lo devuelve en X-Request-Id y registra método/ruta/estado/duración (nunca cabeceras ni cuerpos). */
export function requestLogger(req: AuthedRequest, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // req.path excluye la query string (que podría contener tokens).
    const path = req.path.startsWith('/api/hooks/') ? '/api/hooks/[redacted]' : req.path;
    logger.log(`${req.requestId} ${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
