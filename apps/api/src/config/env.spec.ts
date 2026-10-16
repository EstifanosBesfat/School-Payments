import { loadEnv } from './env';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    API_PUBLIC_URL: 'http://api.internal',
    WEB_URL: 'http://web.internal',
    DATABASE_URL: 'postgresql://payment_app:generated@db.internal:5432/payment',
    REDIS_URL: 'redis://redis.internal:6379',
    JWT_ACCESS_SECRET: 'a-real-production-secret-that-is-long-enough',
    DATA_ENCRYPTION_KEY: encryptionKey,
    RECEIPT_SIGNING_KEY_ID: 'prod-2026',
    RECEIPT_SIGNING_PRIVATE_KEY: 'private-material',
    RECEIPT_SIGNING_PUBLIC_KEY: 'public-material',
    PAYMENT_GATEWAY: 'chapa',
    CHAPA_SECRET_KEY: 'chapa-not-a-live-secret',
    CHAPA_WEBHOOK_SECRET: 'chapa-webhook-not-a-live-secret',
    ...overrides,
  };
}

describe('loadEnv', () => {
  it('names a missing required variable without echoing other secrets', () => {
    const secret = 'a-real-production-secret-that-is-long-enough';
    expect(() => loadEnv(environment({ DATABASE_URL: '' }))).toThrow(/DATABASE_URL/);
    try {
      loadEnv(environment({ DATABASE_URL: '' }));
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(secret);
    }
  });

  it('accepts the local example settings in development', () => {
    const env = loadEnv(
      environment({
        JWT_ACCESS_SECRET: 'change-me-to-a-long-random-string',
        DATABASE_URL: 'postgresql://payment_app:payment_app_dev_password@localhost:5436/payment',
        PAYMENT_GATEWAY: 'mock',
      }),
    );
    expect(env.PAYMENT_GATEWAY).toBe('mock');
  });

  it('rejects the example JWT, development database password, and mock gateway in production', () => {
    expect(() =>
      loadEnv(
        environment({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'change-me-to-a-long-random-string',
        }),
      ),
    ).toThrow(/example placeholder/);
    expect(() =>
      loadEnv(
        environment({
          NODE_ENV: 'production',
          DATABASE_URL:
            'postgresql://payment_app:payment_app_dev_password@db.internal:5432/payment',
        }),
      ),
    ).toThrow(/development database password/);
    try {
      loadEnv(
        environment({
          NODE_ENV: 'production',
          DATABASE_URL:
            'postgresql://payment_app:payment_app_dev_password@db.internal:5432/payment',
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('payment_app_dev_password');
      expect(message).not.toContain('postgresql://');
    }
    expect(() => loadEnv(environment({ NODE_ENV: 'production', PAYMENT_GATEWAY: 'mock' }))).toThrow(
      /mock gateway/,
    );
  });
});
