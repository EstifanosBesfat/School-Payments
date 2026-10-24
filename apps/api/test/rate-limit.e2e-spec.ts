import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPrismaClient, type PrismaClient } from '@payment/db';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { RedisThrottlerStorage } from '../src/common/redis-throttler.storage';

process.env.API_PORT = '4101';
process.env.API_PUBLIC_URL = 'http://localhost:4101';
process.env.REDIS_URL = 'redis://127.0.0.1:6380/1';
process.env.RUN_WORKERS = 'false';
process.env.PAYMENT_GATEWAY = 'mock';
process.env.SMS_PROVIDER = 'console';

/* eslint-disable @typescript-eslint/no-require-imports */
const { loadEnv } = require('../src/config/env') as typeof import('../src/config/env');
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { SecretBox } =
  require('../src/common/crypto.util') as typeof import('../src/common/crypto.util');
const { hashPassword } = require('../src/auth/password') as typeof import('../src/auth/password');
const totp = require('../src/auth/totp') as typeof import('../src/auth/totp');

const env = loadEnv();
const suffix = randomBytes(3).toString('hex');
const password = 'E2e-password-2026';

type Http = ReturnType<typeof request>;

function forwarded(http: Http, ip: string) {
  return {
    post: (path: string) => http.post(path).set('X-Forwarded-For', ip),
    get: (path: string) => http.get(path).set('X-Forwarded-For', ip),
  };
}

async function boot(trustedProxies: string): Promise<INestApplication> {
  process.env.TRUSTED_PROXIES = trustedProxies;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
  });
  await app.init();
  return app;
}

describe('Rate limits (Redis, production thresholds)', () => {
  jest.setTimeout(180_000);

  let trustedApp: INestApplication;
  let untrustedApp: INestApplication;
  let trusted: Http;
  let untrusted: Http;
  let owner: PrismaClient;
  let redis: Redis;

  beforeAll(async () => {
    owner = createPrismaClient({
      connectionString: process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL,
    });
    redis = new Redis(process.env.REDIS_URL ?? env.REDIS_URL, { maxRetriesPerRequest: 1 });
    trustedApp = await boot('127.0.0.1,::1,::ffff:127.0.0.1');
    untrustedApp = await boot('');
    trusted = request(trustedApp.getHttpServer());
    untrusted = request(untrustedApp.getHttpServer());
  });

  afterAll(async () => {
    await trustedApp?.close();
    await untrustedApp?.close();
    await owner?.$disconnect();
    redis?.disconnect();
  });

  it('resets a Redis window without keeping a process-local counter', async () => {
    const storage = new RedisThrottlerStorage(redis);
    const key = `window-${suffix}`;
    expect((await storage.increment(key, 300, 2, 300, 'window-test')).isBlocked).toBe(false);
    expect((await storage.increment(key, 300, 2, 300, 'window-test')).isBlocked).toBe(false);
    expect((await storage.increment(key, 300, 2, 300, 'window-test')).isBlocked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect((await storage.increment(key, 300, 2, 300, 'window-test')).isBlocked).toBe(false);
  });

  it('fails closed when Redis is unreachable', async () => {
    const dead = new Redis({
      host: '127.0.0.1',
      port: 1,
      connectTimeout: 200,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    const storage = new RedisThrottlerStorage(dead);
    await expect(storage.increment('down', 1000, 5, 1000, 'down-test')).rejects.toThrow();
    dead.disconnect();
  });

  it('limits failed logins per client and ignores a spoofed forwarding header', async () => {
    const login = (http: Http, ip: string, apiKey?: string) => {
      const call = forwarded(http, ip)
        .post('/auth/login')
        .send({ email: 'nobody@e2e.test', password: 'wrong-password' });
      return apiKey ? call.set('X-Api-Key', apiKey) : call;
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(trusted, '203.0.113.10')).status).toBe(401);
    }
    expect((await login(trusted, '203.0.113.10')).status).toBe(429);
    expect((await login(trusted, '203.0.113.11')).status).toBe(401);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login(
        untrusted,
        `198.51.100.${attempt + 1}`,
        `mock_api_key_${attempt}`,
      );
      expect(response.status).toBe(401);
    }
    const spoofed = await login(untrusted, '198.51.100.200', 'mock_api_key_blocked');
    expect(spoofed.status).toBe(429);
  });

  it('limits payment starts and public receipt lookups per client', async () => {
    const box = new SecretBox(env.DATA_ENCRYPTION_KEY);
    const school = await owner.school.create({
      data: {
        name: `Rate ${suffix}`,
        code: `RL${suffix}`,
        status: 'ACTIVE',
        contactEmail: 'rate@e2e.test',
        contactPhone: '+251911000010',
      },
    });
    const secret = totp.base32Encode(randomBytes(20));
    await owner.user.create({
      data: {
        email: `rate-${suffix}@e2e.test`,
        name: 'Rate Admin',
        role: 'SCHOOL_ADMIN',
        schoolId: school.id,
        passwordHash: await hashPassword(password),
        totpEnabled: true,
        totpSecretEncrypted: box.encrypt(secret),
      },
    });
    const code = totp.hotp(totp.base32Decode(secret), totp.currentStep(Date.now()));
    const session = await forwarded(trusted, '203.0.113.20')
      .post('/auth/login')
      .send({ email: `rate-${suffix}@e2e.test`, password, totpCode: code });
    expect(session.status).toBe(200);
    const auth = { Authorization: `Bearer ${session.body.accessToken as string}` };

    const fee = await trusted
      .post('/fee-items')
      .set(auth)
      .set('X-Forwarded-For', '203.0.113.20')
      .send({ name: `Fee ${suffix}`, amount: 10_000 });
    expect(fee.status).toBe(201);
    const student = await trusted
      .post('/students')
      .set(auth)
      .set('X-Forwarded-For', '203.0.113.20')
      .send({
        code: `S-${suffix}`,
        firstName: 'Abebe',
        lastName: 'Kebede',
        grade: '5',
        guardians: [{ name: 'Parent', phone: '0911000000', language: 'am' }],
      });
    expect(student.status).toBe(201);
    const invoice = await trusted
      .post('/invoices')
      .set(auth)
      .set('X-Forwarded-For', '203.0.113.20')
      .set('Idempotency-Key', `rate-invoice-${suffix}`)
      .send({
        studentId: student.body.id,
        dueDate: '2026-12-31',
        lines: [{ feeItemId: fee.body.id, description: 'Fee', amount: 10_000 }],
        notify: false,
      });
    expect(invoice.status).toBe(201);
    const payToken = await owner.invoice
      .findUniqueOrThrow({ where: { id: invoice.body.id }, select: { payToken: true } })
      .then((row) => row.payToken);

    const startBody = { payerName: 'Parent Kebede', payerPhone: '0911223344', method: 'telebirr' };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const started = await forwarded(trusted, '192.0.2.10')
        .post(`/pay/${payToken}/start`)
        .send(startBody);
      expect(started.status).toBe(201);
    }
    expect(
      (await forwarded(trusted, '192.0.2.10').post(`/pay/${payToken}/start`).send(startBody))
        .status,
    ).toBe(429);
    expect(
      (await forwarded(trusted, '192.0.2.11').post(`/pay/${payToken}/start`).send(startBody))
        .status,
    ).toBe(201);

    const lookup = '/receipts/lookup?receiptNo=MISSING-1&code=AAAA-BBBB';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await forwarded(trusted, '198.51.100.20').get(lookup)).status).toBe(404);
    }
    expect((await forwarded(trusted, '198.51.100.20').get(lookup)).status).toBe(429);
    expect((await forwarded(trusted, '198.51.100.21').get(lookup)).status).toBe(404);
  });

  it('limits each API key on its own and keeps schools apart', async () => {
    const box = new SecretBox(env.DATA_ENCRYPTION_KEY);
    const schools = await Promise.all(
      ['A', 'B'].map((label) =>
        owner.school.create({
          data: {
            name: `Key ${label} ${suffix}`,
            code: `K${label}${suffix}`,
            status: 'ACTIVE',
            contactEmail: `key-${label}-${suffix}@e2e.test`,
            contactPhone: '+251911000011',
          },
        }),
      ),
    );
    const tokens: string[] = [];
    for (const [index, school] of schools.entries()) {
      const secret = totp.base32Encode(randomBytes(20));
      const email = `key-${index}-${suffix}@e2e.test`;
      await owner.user.create({
        data: {
          email,
          name: `Key Admin ${index}`,
          role: 'SCHOOL_ADMIN',
          schoolId: school.id,
          passwordHash: await hashPassword(password),
          totpEnabled: true,
          totpSecretEncrypted: box.encrypt(secret),
        },
      });
      const code = totp.hotp(totp.base32Decode(secret), totp.currentStep(Date.now()));
      const ip = `203.0.113.${30 + index}`;
      const session = await forwarded(trusted, ip)
        .post('/auth/login')
        .send({ email, password, totpCode: code });
      expect(session.status).toBe(200);
      tokens.push(session.body.accessToken as string);
    }

    const student = await trusted
      .post('/students')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .set('X-Forwarded-For', '203.0.113.30')
      .send({
        code: `KA-${suffix}`,
        firstName: 'Hanna',
        lastName: 'Tesfaye',
        grade: '6',
        guardians: [{ name: 'Parent', phone: '0911000001', language: 'en' }],
      });
    expect(student.status).toBe(201);
    const other = await trusted
      .post('/students')
      .set('Authorization', `Bearer ${tokens[1]}`)
      .set('X-Forwarded-For', '203.0.113.31')
      .send({
        code: `KB-${suffix}`,
        firstName: 'Dawit',
        lastName: 'Mekonnen',
        grade: '6',
        guardians: [{ name: 'Parent', phone: '0911000002', language: 'en' }],
      });
    expect(other.status).toBe(201);

    const keys = [];
    for (const [index, token] of tokens.entries()) {
      const created = await trusted
        .post('/integrations/api-keys')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', `203.0.113.${30 + index}`)
        .send({ name: `SIS ${index}`, scopes: ['students:read', 'invoices:read'] });
      expect(created.status).toBe(201);
      keys.push(created.body.key as string);
    }

    const balancePath = `/v1/students/KA-${suffix}/balance`;
    const own = await trusted
      .get(balancePath)
      .set('X-Api-Key', keys[0]!)
      .set('X-Forwarded-For', '192.0.2.40');
    expect(own.status).toBe(200);
    expect(own.body.student.code).toBe(`KA-${suffix}`);
    const foreign = await trusted
      .get(balancePath)
      .set('X-Api-Key', keys[1]!)
      .set('X-Forwarded-For', '192.0.2.41');
    expect(foreign.status).toBe(404);

    for (let attempt = 1; attempt < 120; attempt += 1) {
      const response = await trusted
        .get(balancePath)
        .set('X-Api-Key', keys[0]!)
        .set('X-Forwarded-For', '192.0.2.40');
      expect(response.status).toBe(200);
    }
    expect(
      (
        await trusted
          .get(balancePath)
          .set('X-Api-Key', keys[0]!)
          .set('X-Forwarded-For', '192.0.2.40')
      ).status,
    ).toBe(429);
    expect(
      (
        await trusted
          .get(balancePath)
          .set('X-Api-Key', keys[0]!)
          .set('X-Forwarded-For', '192.0.2.99')
      ).status,
    ).toBe(429);
    const otherSchool = await trusted
      .get(`/v1/students/KB-${suffix}/balance`)
      .set('X-Api-Key', keys[1]!)
      .set('X-Forwarded-For', '192.0.2.41');
    expect(otherSchool.status).toBe(200);
  });

  it('does not rate-limit the liveness check', async () => {
    for (let attempt = 0; attempt < 130; attempt += 1) {
      expect((await forwarded(trusted, '203.0.113.50').get('/health/live')).status).toBe(200);
    }
  });
});
