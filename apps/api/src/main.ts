import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { normalizeIp, trustedProxySet } from './common/client-address';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const trustedProxies = trustedProxySet(env.TRUSTED_PROXIES);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: false,
  });

  app.set('trust proxy', (ip: string) => trustedProxies.has(normalizeIp(ip)));
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: false });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const origins = [
    env.WEB_URL,
    ...env.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
  ].filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('School Payments API')
    .setDescription(
      'Multi-school fee collection over licensed Ethiopian gateways. Authenticate integrations with `X-Api-Key`; ' +
        'outbound webhooks are signed with HMAC-SHA256 over `${timestamp}.${body}` in the `X-Payment-Signature` header.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-Api-Key', in: 'header' }, 'api-key')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, swagger), {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  await app.listen(env.API_PORT);
  Logger.log(`API listening on ${env.API_PUBLIC_URL} (docs at /docs)`, 'Bootstrap');
}

void bootstrap();
