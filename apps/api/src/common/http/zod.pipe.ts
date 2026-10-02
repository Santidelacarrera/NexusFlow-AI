import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validación estricta de entrada: lo que no está en el esquema se descarta y lo inválido se rechaza con 400. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Datos de entrada inválidos',
        issues: result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

export const zod = <T>(schema: ZodType<T>) => new ZodPipe(schema);
