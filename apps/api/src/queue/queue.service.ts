import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Job, type JobsOptions, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { QUEUES, type QueueName } from './queue.constants';

type JobHandler = (job: Job) => Promise<unknown>;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 2000, age: 7 * 24 * 3600 },
  removeOnFail: { count: 10000 },
};

const CONCURRENCY: Record<QueueName, number> = {
  [QUEUES.webhooks]: 10,
  [QUEUES.payments]: 10,
  [QUEUES.receipts]: 4,
  [QUEUES.notifications]: 10,
  [QUEUES.outbound]: 10,
  [QUEUES.maintenance]: 1,
};

@Injectable()
export class QueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly handlers = new Map<QueueName, Map<string, JobHandler>>();
  private readonly workers: Worker[] = [];

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async add<T extends object>(name: QueueName, jobName: string, data: T, options?: JobsOptions): Promise<void> {
    await this.queue(name).add(jobName, data, options);
  }

  /** Register a handler for one job name on a queue. Called from module onModuleInit hooks. */
  register(name: QueueName, jobName: string, handler: JobHandler): void {
    const map = this.handlers.get(name) ?? new Map<string, JobHandler>();
    map.set(jobName, handler);
    this.handlers.set(name, map);
  }

  /** Repeatable job (deduplicated across API instances by schedulerId). */
  async schedule(name: QueueName, schedulerId: string, pattern: string, jobName: string): Promise<void> {
    await this.queue(name).upsertJobScheduler(
      schedulerId,
      { pattern, tz: 'Africa/Addis_Ababa' },
      { name: jobName, data: {}, opts: { attempts: 1 } },
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.RUN_WORKERS) {
      this.logger.log('RUN_WORKERS=false: queue workers are not started in this process');
      return;
    }
    for (const [name, handlers] of this.handlers) {
      const worker = new Worker(
        name,
        async (job) => {
          const handler = handlers.get(job.name);
          if (!handler) throw new Error(`No handler for job ${job.name} on queue ${name}`);
          return handler(job);
        },
        { connection: this.connection.duplicate(), concurrency: CONCURRENCY[name] },
      );
      worker.on('failed', (job, error) => {
        this.logger.warn(
          `Job ${job?.name ?? 'unknown'} (${job?.id ?? '?'}) on ${name} failed attempt ${job?.attemptsMade ?? 0}: ${error.message}`,
        );
      });
      this.workers.push(worker);
    }
    this.logger.log(`Started ${this.workers.length} queue workers`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.connection.disconnect();
  }
}
