import { Redis } from 'ioredis';

/** Shared by the API, the rate limiter, and BullMQ. Commands wait while Redis reconnects. */
export function createQueueRedis(url: string, warn: (message: string) => void): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  return attachRedisErrorHandler(redis, warn);
}

/** BullMQ calls duplicate() for blocking connections. Those copies do not inherit listeners. */
export function attachRedisErrorHandler(redis: Redis, warn: (message: string) => void): Redis {
  redis.on('error', (error: unknown) => {
    warn(`Redis connection error (${redisErrorLabel(error)})`);
  });
  return redis;
}

/** Avoid logging Redis URLs, passwords, or host details from client errors. */
export function redisErrorLabel(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'Error';
  const message = error instanceof Error ? error.message : '';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EAI_AGAIN/i.test(message)) return `${name} unreachable`;
  if (/ENOTFOUND/i.test(message)) return `${name} ENOTFOUND`;
  if (/ETIMEDOUT|timed out/i.test(message)) return `${name} timeout`;
  if (/NOAUTH|WRONGPASS|password/i.test(message)) return `${name} auth`;
  if (/closed/i.test(message)) return `${name} unreachable`;
  return name;
}
