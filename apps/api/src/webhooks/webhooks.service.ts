import { ConflictException, Injectable, Logger, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@payment/db';
import type { Job } from 'bullmq';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { PaymentLockService } from '../payments/payment-lock.service';
import { PaymentsService, type SettlementOutcome } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, type ProcessWebhookEventJob, QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/**
 * The webhook body is only a hint to re-verify. A payload that claims success is not proof of
 * payment: if Chapa's verify call still says failed or pending, the worker must try again
 * instead of acknowledging the event as finished.
 */
function claimText(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function claimsSuccess(value: string): boolean {
  return value === 'success' || value === 'successful';
}

/** A gateway body that says the payer succeeded. Chapa uses status/event. ArifPay uses transactionStatus. The body is still only a hint. */
export function gatewayPayloadClaimsSuccess(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const body = payload as Record<string, unknown>;
  const nested = body.transaction;
  const nestedStatus = nested && typeof nested === 'object' ? claimText((nested as Record<string, unknown>).transactionStatus) : '';
  const eventName = claimText(body.event);
  return (
    claimsSuccess(claimText(body.status)) ||
    claimsSuccess(claimText(body.transactionStatus)) ||
    claimsSuccess(nestedStatus) ||
    eventName === 'charge.success' ||
    eventName === 'payment.success'
  );
}

export class GatewaySuccessUnconfirmedError extends Error {
  constructor(txRef: string, outcome: SettlementOutcome) {
    super(`Gateway verification has not confirmed success for ${txRef} (${outcome})`);
    this.name = 'GatewaySuccessUnconfirmedError';
  }
}

function needsAnotherVerification(outcome: SettlementOutcome): boolean {
  return outcome === 'failed' || outcome === 'already_failed' || outcome === 'still_pending' || outcome === 'expired';
}

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: GatewayRegistry,
    private readonly payments: PaymentsService,
    private readonly queues: QueueService,
    private readonly locks: PaymentLockService,
  ) {}

  onModuleInit(): void {
    this.queues.register(QUEUES.webhooks, JOBS.processWebhookEvent, (job: Job<ProcessWebhookEventJob>) =>
      this.process(job.data.webhookEventId),
    );
  }

  /**
   * Fast path: verify signature, persist once, enqueue, acknowledge. Business logic runs in the
   * worker so the gateway gets its 200 quickly and redeliveries are harmless.
   */
  async receive(
    gatewayName: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true; duplicate: boolean }> {
    const gateway = this.gateways.get(gatewayName);
    const parsed = gateway.parseWebhook(rawBody, headers);
    if (!parsed.signatureValid) {
      this.logger.warn(`Rejected ${gatewayName} webhook with invalid signature (event ${parsed.eventType})`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Held for 10 seconds (NX). A Chapa retry storm, or the pending sweep, loses the race and
    // must not start a second verify for this tx_ref. The lock stays until it expires so the
    // worker that won can finish; it is released only when this request will not process.
    if (parsed.txRef) {
      const acquired = await this.locks.acquire(parsed.txRef);
      if (!acquired) {
        this.logger.warn(`Webhook for ${parsed.txRef} arrived while that payment is already being verified`);
        throw new ConflictException('This payment is already being processed');
      }
    }

    try {
      const event = await this.prisma.db.webhookEvent.create({
        data: {
          gateway: gatewayName,
          eventKey: parsed.eventKey,
          eventType: parsed.eventType,
          txRef: parsed.txRef,
          sessionId: parsed.sessionId ?? null,
          signatureValid: true,
          payload: JSON.parse(JSON.stringify(parsed.payload ?? {})) as Prisma.InputJsonValue,
        },
      });
      await this.queues.add<ProcessWebhookEventJob>(QUEUES.webhooks, JOBS.processWebhookEvent, { webhookEventId: event.id }, { jobId: `whe-${event.id}` });
      return { received: true, duplicate: false };
    } catch (error) {
      if (parsed.txRef) await this.locks.release(parsed.txRef);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { received: true, duplicate: true };
      }
      throw error;
    }
  }

  private async process(webhookEventId: string): Promise<void> {
    const event = await this.prisma.db.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event || event.status === 'PROCESSED' || event.status === 'IGNORED') return;

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (!event.txRef || payload['type'] === 'Payout' || event.eventType.startsWith('payout.')) {
      await this.prisma.db.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'IGNORED', processedAt: new Date(), attempts: { increment: 1 } },
      });
      return;
    }

    try {
      const outcome = await this.payments.verifyAndSettle(event.txRef, 'webhook');
      if (gatewayPayloadClaimsSuccess(payload) && needsAnotherVerification(outcome)) {
        throw new GatewaySuccessUnconfirmedError(event.txRef, outcome);
      }
      await this.prisma.db.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: outcome === 'unknown_payment' ? 'IGNORED' : 'PROCESSED',
          processedAt: new Date(),
          attempts: { increment: 1 },
          error:
            outcome === 'unknown_payment'
              ? 'No payment with this tx_ref'
              : outcome === 'rejected'
                ? 'Verification did not match this payment'
                : null,
        },
      });
    } catch (error) {
      await this.prisma.db.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', attempts: { increment: 1 }, error: (error as Error).message.slice(0, 500) },
      });
      throw error;
    }
  }
}
