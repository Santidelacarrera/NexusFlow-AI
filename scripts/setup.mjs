import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parse = (file) =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      )
    : {};
const random = (bytes = 48) => randomBytes(bytes).toString('base64url');
const envPath = resolve(root, '.env');
const env = parse(envPath);
const defaults = {
  POSTGRES_PASSWORD: random(),
  JWT_ACCESS_SECRET: random(),
  AUDIT_HMAC_KEY: random(),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ML_SERVICE_TOKEN: random(),
  WEB_PORT: '8088',
  CORS_ORIGINS: 'http://localhost:8088',
  ALLOW_REGISTRATION: 'true',
};
for (const [key, value] of Object.entries(defaults)) if (!env[key]) env[key] = value;
writeFileSync(
  envPath,
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
const apiPath = resolve(root, 'apps/api/.env');
let apiEnv = existsSync(apiPath)
  ? readFileSync(apiPath, 'utf8')
  : readFileSync(resolve(root, 'apps/api/.env.example'), 'utf8');
const newApi = !existsSync(apiPath);
for (const key of ['JWT_ACCESS_SECRET', 'AUDIT_HMAC_KEY', 'ML_SERVICE_TOKEN', 'DATA_ENCRYPTION_KEY']) {
  const current = parse(apiPath)[key];
  const example =
    !current || current.includes('change-me') || current === 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
  if (example) {
    const line = `${key}=${env[key]}`;
    apiEnv = new RegExp(`^${key}=.*$`, 'm').test(apiEnv)
      ? apiEnv.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${apiEnv}\n${line}`;
  }
}
if (newApi) {
  apiEnv = apiEnv.replace(
    /^DATABASE_URL=.*$/m,
    `DATABASE_URL=postgresql://nexus:${env.POSTGRES_PASSWORD}@localhost:54330/nexusflow?schema=public`,
  );
  apiEnv = apiEnv.replace(/^REDIS_URL=.*$/m, 'REDIS_URL=redis://localhost:63800');
}
apiEnv = apiEnv.replace(/^PORT=3000$/m, 'PORT=3001');
writeFileSync(apiPath, apiEnv, { mode: 0o600 });
console.log('Entorno preparado. Secretos de ejemplo sustituidos; credenciales personalizadas conservadas.');
console.log('Docker: docker compose up --build -d | Aplicación: http://localhost:' + env.WEB_PORT);
console.log(
  'Desarrollo: API puerto 3001, web puerto 5173. Revisa apps/api/.env si ya tenías una base de datos.',
);
