import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';

/** How long a tx_ref stays exclusive while a webhook or the pending sweep claims it. */
export const PAYMENT_LOCK_TTL_SECONDS = 10;

export function paymentLockKey(txRef: string): string {
  return `payment:lock:${txRef}`;
}

/**
 * Short Redis lock shared by the webhook receiver and the pending-payment sweep.
 * SET key EX 10 NX so only one of them starts work for a tx_ref. The database row lock
 * inside settlement is still what prevents a double post if this key expires mid-verify.
 */
@Injectable()
export class PaymentLockService {
  private readonly logger = new Logger(PaymentLockService.name);

  constructor(private readonly queues: QueueService) {}

  /**
   * True when this caller owns the lock. A Redis outage fails open: refusing every webhook
   * until Redis is back would leave a paid Chapa transaction sitting unverified, and the
   * settlement transaction still serializes the money movement.
   */
  async acquire(txRef: string): Promise<boolean> {
    try {
      const result = await this.queues.connection.set(
        paymentLockKey(txRef),
        '1',
        'EX',
        PAYMENT_LOCK_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      const label = error instanceof Error ? error.name : 'Error';
      this.logger.warn(`Payment lock unavailable for ${txRef} (${label}); continuing without it`);
      return true;
    }
  }

  async release(txRef: string): Promise<void> {
    try {
      await this.queues.connection.del(paymentLockKey(txRef));
    } catch (error) {
      const label = error instanceof Error ? error.name : 'Error';
      this.logger.warn(`Payment lock release failed for ${txRef} (${label})`);
    }
  }
}
