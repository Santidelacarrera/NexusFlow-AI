import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthedRequest } from './types';

/**
 * Filtro global: nunca filtra trazas, mensajes de BD ni detalles internos al cliente.
 * Los errores 5xx se registran con el requestId para poder correlacionarlos.
 */
const PARSER_ERROR = /JSON|position \d+|Unexpected (token|end)|Expected property/i;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AuthedRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Error interno del servidor' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      body =
        typeof response === 'string' ? { message: response } : { ...(response as Record<string, unknown>) };
      delete body.statusCode;
      if (status >= 500) body = { message: 'Error interno del servidor' };
      // Los errores del parser JSON incluyen posiciones/fragmentos del cuerpo: se sustituyen por un mensaje genérico.
      else if (status === 400 && typeof body.message === 'string' && PARSER_ERROR.test(body.message))
        body = { message: 'JSON inválido', error: 'Bad Request' };
    } else if ((exception as { type?: string })?.type === 'entity.too.large') {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      body = { message: 'La petición supera el tamaño máximo permitido' };
    } else if ((exception as { type?: string })?.type === 'entity.parse.failed') {
      status = HttpStatus.BAD_REQUEST;
      body = { message: 'JSON inválido' };
    }

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(
        `[${req.requestId}] ${req.method} ${req.path} -> ${status}: ${err.message}`,
        err.stack,
      );
    }

    res.status(status).json({ statusCode: status, ...body, requestId: req.requestId });
  }
}
