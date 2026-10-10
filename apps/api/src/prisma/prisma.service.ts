import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type Prisma, type PrismaClient } from '@payment/db';
import { APP_ENV, type AppEnv } from '../config/config.module';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly db: PrismaClient;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.db = createPrismaClient({ connectionString: env.DATABASE_URL, maxConnections: 15 });
  }

  /**
   * Runs fn in a transaction with `app.school_id` set, so PostgreSQL Row-Level Security
   * hides every other school's rows even if a query forgets its schoolId filter.
   */
  async tenant<T>(
    schoolId: string,
    fn: (tx: Tx) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.school_id', ${schoolId}, true)`;
        return fn(tx);
      },
      { timeout: options?.timeout ?? 15000, isolationLevel: options?.isolationLevel },
    );
  }

  /** System context (workers, gateway webhooks): no tenant restriction, explicit by name. */
  async system<T>(
    fn: (tx: Tx) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ): Promise<T> {
    return this.db.$transaction(fn, {
      timeout: options?.timeout ?? 15000,
      isolationLevel: options?.isolationLevel,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}
