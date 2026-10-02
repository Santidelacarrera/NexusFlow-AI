import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getEnv } from './common/config/env';
import { AllExceptionsFilter } from './common/http/exception.filter';
import { apiSecurityHeaders } from './common/http/security-headers';
import { requestLogger } from './common/http/request-logger.middleware';

export async function bootstrap() {
  const env = getEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.use(requestLogger);
  app.use(helmet());
  app.use(apiSecurityHeaders);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '100kb' });
  app.useBodyParser('urlencoded', { limit: '100kb', extended: false });
  const origins = env.CORS_ORIGINS.split(',').map((v) => v.trim());
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  return app;
}

if (require.main === module)
  void bootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
