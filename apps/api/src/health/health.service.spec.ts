import { type INestApplication, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { HealthController } from './health.controller';
import { HealthService, withTimeout } from './health.service';

const SECRET = 'postgresql://payment_owner:super-secret-db-password@127.0.0.1:5436/payment';

function probes() {
  return {
    queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    ping: jest.fn().mockResolvedValue('PONG'),
  };
}

async function boot(queryRaw: jest.Mock, ping: jest.Mock): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: PrismaService, useValue: { db: { $queryRaw: queryRaw } } },
      { provide: QueueService, useValue: { connection: { ping } } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('health checks', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    warn.mockClear();
  });

  afterAll(() => {
    warn.mockRestore();
  });

  it('reports liveness without calling PostgreSQL or Redis', async () => {
    const { queryRaw, ping } = probes();
    queryRaw.mockRejectedValue(new Error(SECRET));
    ping.mockRejectedValue(new Error(SECRET));
    const app = await boot(queryRaw, ping);
    try {
      const response = await request(app.getHttpServer()).get('/health/live');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
      expect(queryRaw).not.toHaveBeenCalled();
      expect(ping).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain('super-secret-db-password');
    } finally {
      await app.close();
    }
  });

  it('reports ready when PostgreSQL and Redis answer', async () => {
    const { queryRaw, ping } = probes();
    const app = await boot(queryRaw, ping);
    try {
      const response = await request(app.getHttpServer()).get('/health/ready');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        checks: { database: 'ok', redis: 'ok' },
      });
      const sql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
      expect(sql).toBe('SELECT 1');
      expect(sql).not.toMatch(/insert|update|delete|drop|alter|truncate|migrate/i);
      expect(ping).toHaveBeenCalledWith();
      expect(queryRaw).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when PostgreSQL is unavailable and hides the error', async () => {
    const { queryRaw, ping } = probes();
    queryRaw.mockRejectedValue(new Error(`connection failed ${SECRET}`));
    const app = await boot(queryRaw, ping);
    try {
      const response = await request(app.getHttpServer()).get('/health/ready');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'degraded',
        checks: { database: 'down', redis: 'ok' },
      });
      expect(JSON.stringify(response.body)).not.toContain('super-secret-db-password');
      expect(JSON.stringify(response.body)).not.toContain('postgresql://');
      expect(JSON.stringify(response.body)).not.toContain('connection failed');
      expect(warn.mock.calls.map((call) => String(call[0])).join(' ')).not.toContain(SECRET);
      expect(warn).toHaveBeenCalledWith('Readiness database check failed (error)');
    } finally {
      await app.close();
    }
  });

  it('returns 503 when Redis is unavailable and hides the error', async () => {
    const { queryRaw, ping } = probes();
    ping.mockRejectedValue(new Error(`Redis error ${SECRET}`));
    const app = await boot(queryRaw, ping);
    try {
      const response = await request(app.getHttpServer()).get('/health/ready');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'degraded',
        checks: { database: 'ok', redis: 'down' },
      });
      expect(JSON.stringify(response.body)).not.toContain('super-secret-db-password');
      expect(warn).toHaveBeenCalledWith('Readiness redis check failed (error)');
    } finally {
      await app.close();
    }
  });

  it('bounds a stalled dependency and still answers', async () => {
    const { queryRaw, ping } = probes();
    queryRaw.mockReturnValue(new Promise(() => undefined));
    const service = new HealthService(
      { db: { $queryRaw: queryRaw } } as unknown as PrismaService,
      { connection: { ping } } as unknown as QueueService,
    );
    const started = Date.now();
    const report = await service.ready(40);
    expect(Date.now() - started).toBeLessThan(400);
    expect(report).toEqual({ status: 'degraded', checks: { database: 'down', redis: 'ok' } });
    expect(warn).toHaveBeenCalledWith('Readiness database check failed (timeout)');
  });

  it('does not surface a late dependency error after the timeout', async () => {
    const late = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(SECRET)), 30);
    });
    await expect(withTimeout(late, 10)).rejects.toMatchObject({ name: 'HealthTimeoutError' });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('turns a dependency failure into an HTTP exception without throwing it as a crash', async () => {
    const service = new HealthService(
      {
        db: { $queryRaw: jest.fn().mockRejectedValue(new Error(SECRET)) },
      } as unknown as PrismaService,
      { connection: { ping: jest.fn().mockResolvedValue('PONG') } } as unknown as QueueService,
    );
    const report = await service.ready(40);
    const http = new ServiceUnavailableException(report);
    expect(http.getStatus()).toBe(503);
    expect(http.getResponse()).toEqual({
      status: 'degraded',
      checks: { database: 'down', redis: 'ok' },
    });
  });
});
