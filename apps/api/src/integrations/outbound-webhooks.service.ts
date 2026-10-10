import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@payment/db';
import {
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_TIMESTAMP_HEADER,
  type OutboundWebhookEvent,
} from '@payment/shared';
import type { Job } from 'bullmq';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hmacSha256Hex, SecretBox } from '../common/crypto.util';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { type DeliverWebhookJob, JOBS, QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

const MAX_ATTEMPTS = 8;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.');
  }
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Signed event notifications to schools' own systems (ERP, SIS, accounting).
 * Signature: hex HMAC-SHA256 of `${timestamp}.${body}` with the endpoint secret.
 */
@Injectable()
export class OutboundWebhooksService implements OnModuleInit {
  private readonly logger = new Logger(OutboundWebhooksService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly secrets: SecretBox,
  ) {}

  onModuleInit(): void {
    this.queues.register(QUEUES.outbound, JOBS.deliverWebhook, (job: Job<DeliverWebhookJob>) => this.deliver(job));
  }

  async emit(schoolId: string, event: OutboundWebhookEvent, data: Prisma.InputJsonObject): Promise<void> {
    const endpoints = await this.prisma.db.webhookEndpoint.findMany({
      where: { schoolId, isActive: true, events: { has: event } },
      select: { id: true },
    });
    for (const endpoint of endpoints) {
      const delivery = await this.prisma.tenant(schoolId, (tx) =>
        tx.webhookDelivery.create({
          data: { schoolId, endpointId: endpoint.id, event, payload: data },
        }),
      );
      await this.queues.add<DeliverWebhookJob>(QUEUES.outbound, JOBS.deliverWebhook, { deliveryId: delivery.id }, {
        jobId: `wh-${delivery.id}`,
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 10000 },
      });
    }
  }

  async assertSafeUrl(url: string): Promise<void> {
    const parsed = new URL(url);
    if (this.env.NODE_ENV === 'production') {
      if (parsed.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS');
      const addresses = isIP(parsed.hostname) ? [{ address: parsed.hostname }] : await lookup(parsed.hostname, { all: true });
      if (addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new Error('Webhook URL resolves to a private network address');
      }
    }
  }

  signatureFor(secret: string, timestamp: string, body: string): string {
    return hmacSha256Hex(secret, `${timestamp}.${body}`);
  }

  private async deliver(job: Job<DeliverWebhookJob>): Promise<void> {
    const delivery = await this.prisma.db.webhookDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { endpoint: true },
    });
    if (!delivery || delivery.status === 'SUCCEEDED' || !delivery.endpoint.isActive) return;

    const body = JSON.stringify({
      id: delivery.id,
      event: delivery.event,
      createdAt: delivery.createdAt.toISOString(),
      data: delivery.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = this.secrets.decrypt(delivery.endpoint.secretEncrypted);
    let status: number | null = null;
    let errorMessage: string | null = null;
    try {
      await this.assertSafeUrl(delivery.endpoint.url);
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SchoolPayments-Webhooks/1.0',
          [OUTBOUND_TIMESTAMP_HEADER]: timestamp,
          [OUTBOUND_SIGNATURE_HEADER]: this.signatureFor(secret, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      status = response.status;
      if (!response.ok) errorMessage = `HTTP ${response.status}`;
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    const attempts = delivery.attempts + 1;
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? MAX_ATTEMPTS);
    await this.prisma.tenant(delivery.schoolId, (tx) =>
      tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          responseStatus: status,
          lastError: errorMessage,
          status: errorMessage ? (finalAttempt ? 'FAILED' : 'PENDING') : 'SUCCEEDED',
          deliveredAt: errorMessage ? null : new Date(),
        },
      }),
    );
    if (errorMessage) {
      this.logger.warn(`Webhook delivery ${delivery.id} to ${new URL(delivery.endpoint.url).host} failed: ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
}
