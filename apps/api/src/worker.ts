import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Dedicated background worker process. Run the API with RUN_WORKERS=false and scale this
 * process separately so webhook processing, receipts and SMS never compete with HTTP traffic.
 */
async function bootstrap(): Promise<void> {
  process.env.RUN_WORKERS = 'true';
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  Logger.log('Worker started', 'Worker');
}

void bootstrap();
