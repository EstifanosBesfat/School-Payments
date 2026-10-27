import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

/** A stalled database or Redis call must not hold the health request longer than this. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export type DependencyCheck = 'ok' | 'down';
export type WorkerCheck = 'ok' | 'warn' | 'critical';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: { database: DependencyCheck; redis: DependencyCheck };
}

export interface WorkerHealthReport {
  status: 'ok' | 'degraded' | 'critical';
  checks: {
    openIssues: { status: WorkerCheck; count: number; threshold: number };
    stalePending: { status: WorkerCheck; count: number; threshold: number };
    lastReconciliation: { status: WorkerCheck; hoursAgo: number | null; threshold: number; lastError: string | null };
  };
  timestamp: string;
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

  /**
   * Worker health monitoring for sweep worker and reconciliation system.
   * Detects issues with payment synchronization and multi-attempt checkout failures.
   */
  async workers(): Promise<WorkerHealthReport> {
    const now = Date.now();

    // Check 1: Open reconciliation issues (indicates unresolved payment discrepancies)
    const openIssuesCount = await this.prisma.db.reconciliationIssue.count({
      where: { status: 'OPEN' },
    });
    const openIssuesThreshold = 10;
    const openIssuesStatus: WorkerCheck =
      openIssuesCount > openIssuesThreshold * 2
        ? 'critical'
        : openIssuesCount > openIssuesThreshold
          ? 'warn'
          : 'ok';

    // Check 2: Stale pending payments (should be picked up by sweep worker within 10 min)
    const stalePendingCount = await this.prisma.db.payment.count({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now - 60 * 60 * 1000) }, // Older than 1 hour
      },
    });
    const stalePendingThreshold = 5;
    const stalePendingStatus: WorkerCheck =
      stalePendingCount > stalePendingThreshold * 2
        ? 'critical'
        : stalePendingCount > stalePendingThreshold
          ? 'warn'
          : 'ok';

    // Check 3: Last full reconciliation run (should run nightly at 2:30 AM)
    const lastReconciliation = await this.prisma.db.reconciliationRun.findFirst({
      where: { finishedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, finishedAt: true, error: true },
    });

    let lastReconciliationHours: number | null = null;
    let lastReconciliationStatus: WorkerCheck = 'ok';
    let lastError: string | null = null;

    if (lastReconciliation) {
      lastReconciliationHours = Math.floor(
        (now - lastReconciliation.startedAt.getTime()) / (60 * 60 * 1000),
      );
      lastError = lastReconciliation.error;
      const reconciliationThreshold = 30; // Should run every 24h, warn at 30h

      if (lastReconciliation.error) {
        lastReconciliationStatus = 'critical'; // Last run failed
      } else if (lastReconciliationHours > reconciliationThreshold * 1.5) {
        lastReconciliationStatus = 'critical'; // Not run in 45h
      } else if (lastReconciliationHours > reconciliationThreshold) {
        lastReconciliationStatus = 'warn'; // Not run in 30h
      }
    } else {
      lastReconciliationStatus = 'warn'; // Never run
    }

    // Overall status
    const allStatuses = [openIssuesStatus, stalePendingStatus, lastReconciliationStatus];

    const overallStatus = allStatuses.includes('critical')
      ? 'critical'
      : allStatuses.includes('warn')
        ? 'degraded'
        : 'ok';

    return {
      status: overallStatus,
      checks: {
        openIssues: {
          status: openIssuesStatus,
          count: openIssuesCount,
          threshold: openIssuesThreshold,
        },
        stalePending: {
          status: stalePendingStatus,
          count: stalePendingCount,
          threshold: stalePendingThreshold,
        },
        lastReconciliation: {
          status: lastReconciliationStatus,
          hoursAgo: lastReconciliationHours,
          threshold: 30,
          lastError,
        },
      },
      timestamp: new Date().toISOString(),
    };
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
