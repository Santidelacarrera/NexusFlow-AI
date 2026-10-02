import { BadRequestException, InternalServerErrorException, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './exception.filter';

function run(exception: unknown) {
  let out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(s: number) {
      out.status = s;
      return { json: (b: Record<string, unknown>) => void (out.body = b) };
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ requestId: 'rid', method: 'GET', path: '/x' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return out;
}

describe('AllExceptionsFilter', () => {
  it('no filtra detalles del parser JSON', () => {
    const r = run(new BadRequestException("Expected property name or '}' in JSON at position 1"));
    expect(r.body?.message).toBe('JSON inválido');
    expect(JSON.stringify(r.body)).not.toContain('position');
  });
  it('oculta errores 5xx y errores desconocidos', () => {
    expect(run(new InternalServerErrorException('PrismaClientKnownRequestError: secret')).body?.message).toBe(
      'Error interno del servidor',
    );
    const r = run(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.5');
    expect(r.body?.requestId).toBe('rid');
  });
  it('conserva los mensajes de validación legítimos', () => {
    expect(run(new BadRequestException('Datos de entrada inválidos')).body?.message).toBe(
      'Datos de entrada inválidos',
    );
  });
});
