import { existsSync } from 'node:fs';
import { z } from 'zod';

const INSECURE_MARKERS = ['change-me', 'changeme', 'password', 'secret123'];
const EXAMPLE_ENC_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    ALLOW_REGISTRATION: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
    DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'DATA_ENCRYPTION_KEY debe ser 32 bytes en base64 (openssl rand -base64 32)',
    }),
    AUDIT_HMAC_KEY: z.string().min(32, 'AUDIT_HMAC_KEY debe tener al menos 32 caracteres'),
    ML_SERVICE_URL: z.string().url().default('http://localhost:8001'),
    ML_SERVICE_TOKEN: z.string().min(32, 'ML_SERVICE_TOKEN debe tener al menos 32 caracteres'),
    HTTP_ACTION_ALLOWLIST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.CORS_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'El comodín "*" no está permitido' });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.REDIS_URL)
        ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'Redis es obligatorio en producción' });
      if (env.CORS_ORIGINS.split(',').some((origin) => !origin.trim().startsWith('https://')))
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'Producción requiere orígenes HTTPS',
        });
      for (const key of ['JWT_ACCESS_SECRET', 'AUDIT_HMAC_KEY', 'ML_SERVICE_TOKEN'] as const) {
        const value = env[key].toLowerCase();
        if (INSECURE_MARKERS.some((m) => value.includes(m))) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} contiene un valor de ejemplo inseguro`,
          });
        }
      }
      if (env.DATA_ENCRYPTION_KEY === EXAMPLE_ENC_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATA_ENCRYPTION_KEY'],
          message: 'DATA_ENCRYPTION_KEY es la clave de ejemplo',
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Valida el entorno y falla rápido (fail-fast) con un mensaje claro si falta algo o es inseguro. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  if (!cached) {
    if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
    cached = loadEnv();
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
