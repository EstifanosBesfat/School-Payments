import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

/** A stalled database or Redis call must not hold the health request longer than this. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export type DependencyCheck = 'ok' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: { database: DependencyCheck; redis: DependencyCheck };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  /**
   * Read-only probes. PostgreSQL is required for every payment record. Redis is required
   * for rate limits (fail closed) and for queueing gateway verification. Chapa and SMS are
   * not probed: the API can still serve stored invoices, receipts, and auth without them.
   */
  async ready(timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.probe('database', () => this.prisma.db.$queryRaw`SELECT 1`, timeoutMs),
      this.probe('redis', () => this.queues.connection.ping(), timeoutMs),
    ]);
    const checks = { database, redis };
    return { status: database === 'ok' && redis === 'ok' ? 'ok' : 'degraded', checks };
  }

  private async probe(
    name: 'database' | 'redis',
    run: () => Promise<unknown>,
    timeoutMs: number,
  ): Promise<DependencyCheck> {
    try {
      await withTimeout(run(), timeoutMs);
      return 'ok';
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'HealthTimeoutError' ? 'timeout' : 'error';
      this.logger.warn(`Readiness ${name} check failed (${reason})`);
      return 'down';
    }
  }
}

export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeout = new Error('health check timed out');
      timeout.name = 'HealthTimeoutError';
      reject(timeout);
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
