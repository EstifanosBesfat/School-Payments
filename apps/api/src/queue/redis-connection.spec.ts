import { attachRedisErrorHandler, createQueueRedis, redisErrorLabel } from './redis-connection';

describe('redis connection errors', () => {
  it('labels failures without keeping the Redis URL', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { name: 'Error' });
    expect(redisErrorLabel(refused)).toBe('Error unreachable');
    expect(redisErrorLabel(new Error('NOAUTH Authentication required'))).toBe('Error auth');
    expect(redisErrorLabel(new Error('getaddrinfo ENOTFOUND payment-redis'))).toBe(
      'Error ENOTFOUND',
    );
    expect(redisErrorLabel(new Error('something unexpected'))).toBe('Error');
  });

  it('stays up when Redis is unreachable and does not log the password', async () => {
    const warnings: string[] = [];
    const password = 'super-secret-redis-password';
    const redis = createQueueRedis(`redis://:${password}@127.0.0.1:1/0`, (message) =>
      warnings.push(message),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for the Redis error')),
          5000,
        );
        redis.once('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(warnings.length).toBeGreaterThan(0);
      const logged = warnings.join(' ');
      expect(logged).toMatch(/Redis connection error \(Error/);
      expect(logged).not.toContain(password);
      expect(logged).not.toContain('redis://');
      expect(logged).not.toContain('127.0.0.1');
    } finally {
      redis.disconnect();
    }
  });

  it('handles errors on a duplicated connection', async () => {
    const warnings: string[] = [];
    const redis = createQueueRedis('redis://127.0.0.1:1/0', (message) => warnings.push(message));
    const copy = attachRedisErrorHandler(redis.duplicate(), (message) => warnings.push(message));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for the duplicated Redis error')),
          5000,
        );
        copy.once('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.join(' ')).not.toContain('redis://');
    } finally {
      copy.disconnect();
      redis.disconnect();
    }
  });
});
