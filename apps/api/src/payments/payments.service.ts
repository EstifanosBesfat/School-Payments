import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type Payment } from '@payment/db';
import type { StartPaymentInput } from '@payment/shared';
import type { Job } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { randomReference } from '../common/crypto.util';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { GatewayError, type VerifiedTransaction } from '../gateways/payment-gateway.interface';
import { OutboundWebhooksService } from '../integrations/outbound-webhooks.service';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { JOBS, QUEUES, type VerifyPaymentJob } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

const REUSE_CHECKOUT_WINDOW_MS = 30 * 60 * 1000;
const PENDING_EXPIRY_MS = 24 * 3600 * 1000;

export type SettlementOutcome =
  | 'unknown_payment'
  | 'already_final'
  | 'still_pending'
  | 'succeeded'
  | 'failed'
  | 'review'
  | 'refunded'
  | 'expired';

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() ?? 'Parent';
  return { firstName, lastName: parts.join(' ') || firstName };
}

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly gateways: GatewayRegistry,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly outbound: OutboundWebhooksService,
  ) {}

  onModuleInit(): void {
    this.queues.register(QUEUES.payments, JOBS.verifyPayment, async (job: Job<VerifyPaymentJob>) =>
      this.verifyAndSettle(job.data.txRef, job.data.reason),
    );
  }

  async enqueueVerification(txRef: string, reason: VerifyPaymentJob['reason'], delayMs = 0): Promise<void> {
    await this.queues.add<VerifyPaymentJob>(QUEUES.payments, JOBS.verifyPayment, { txRef, reason }, {
      delay: delayMs,
      jobId: delayMs > 0 ? `verify-${txRef}-${Date.now() + delayMs}` : undefined,
    });
  }

  platformFeeFor(amount: number): number {
    if (this.env.PLATFORM_FEE_VALUE <= 0) return 0;
    if (this.env.PLATFORM_FEE_TYPE === 'flat') return Math.round(this.env.PLATFORM_FEE_VALUE * 100);
    return Math.round(amount * this.env.PLATFORM_FEE_VALUE);
  }

  /** Public pay page: creates (or reuses) a payment attempt and returns the gateway checkout URL. */
  async start(payToken: string, input: StartPaymentInput, ip?: string): Promise<{ checkoutUrl: string; txRef: string }> {
    const invoice = await this.prisma.db.invoice.findUnique({
      where: { payToken },
      include: { school: true, student: true, lines: { orderBy: { position: 'asc' } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.school.status !== 'ACTIVE') throw new BadRequestException('This school is not accepting online payments yet');
    if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
      throw new BadRequestException(`This invoice is ${invoice.status.toLowerCase().replace('_', ' ')}`);
    }
    const amount = invoice.totalAmount - invoice.paidAmount;
    if (amount <= 0) throw new BadRequestException('Nothing left to pay on this invoice');

    const gateway = this.gateways.default();
    if (gateway.name === 'chapa' && !invoice.school.chapaSubaccountId) {
      throw new BadRequestException('This school has not finished its payout setup');
    }

    const reusable = await this.prisma.db.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: 'PENDING',
        amount,
        payerPhone: input.payerPhone,
        gateway: gateway.name,
        checkoutUrl: { not: null },
        createdAt: { gt: new Date(Date.now() - REUSE_CHECKOUT_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (reusable?.checkoutUrl) return { checkoutUrl: reusable.checkoutUrl, txRef: reusable.txRef };

    const txRef = `${invoice.school.code}-${randomReference(14)}`;
    const payment = await this.prisma.tenant(invoice.schoolId, async (tx) => {
      const created = await tx.payment.create({
        data: {
          schoolId: invoice.schoolId,
          invoiceId: invoice.id,
          txRef,
          gateway: gateway.name,
          amount,
          payerName: input.payerName,
          payerPhone: input.payerPhone,
          payerEmail: input.payerEmail,
        },
      });
      await this.audit.record(
        {
          schoolId: invoice.schoolId,
          actorType: 'payer',
          actorId: null,
          action: 'payment.started',
          entityType: 'Payment',
          entityId: created.id,
          metadata: { txRef, amount, invoiceNumber: invoice.number },
          ip,
        },
        tx,
      );
      return created;
    });

    const { firstName, lastName } = splitName(input.payerName);
    try {
      const result = await gateway.initialize({
        txRef,
        amount,
        currency: 'ETB',
        customer: { firstName, lastName, phone: input.payerPhone, email: input.payerEmail },
        callbackUrl: `${this.env.API_PUBLIC_URL}/payments/callback/${gateway.name}`,
        returnUrl: `${this.env.WEB_URL}/pay/${payToken}/return?tx=${encodeURIComponent(txRef)}`,
        title: 'School Fees',
        description: `${invoice.school.code} ${invoice.number}`,
        split: invoice.school.chapaSubaccountId
          ? {
              subaccountId: invoice.school.chapaSubaccountId,
              type: this.env.PLATFORM_FEE_TYPE,
              value: this.env.PLATFORM_FEE_TYPE === 'flat' ? Math.round(this.env.PLATFORM_FEE_VALUE * 100) : this.env.PLATFORM_FEE_VALUE,
            }
          : undefined,
        lineItems: invoice.lines.map((line) => ({ label: line.description, value: (line.amount / 100).toFixed(2) })),
      });
      await this.prisma.tenant(invoice.schoolId, (tx) =>
        tx.payment.update({ where: { id: payment.id }, data: { checkoutUrl: result.checkoutUrl } }),
      );
      await this.enqueueVerification(txRef, 'sweep', 15 * 60 * 1000);
      return { checkoutUrl: result.checkoutUrl, txRef };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Gateway initialize failed for ${txRef}: ${message}`);
      await this.prisma.tenant(invoice.schoolId, (tx) =>
        tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: `initialize_failed: ${message.slice(0, 300)}` } }),
      );
      throw new BadGatewayException('The payment provider is unavailable. Please try again in a few minutes.');
    }
  }

  /**
   * The only path that changes a payment's money state. Always re-queries the gateway, then
   * applies the result inside one transaction with row locks so concurrent webhooks, callbacks
   * and sweeps cannot double-settle.
   */
  async verifyAndSettle(txRef: string, reason: VerifyPaymentJob['reason']): Promise<SettlementOutcome> {
    const payment = await this.prisma.db.payment.findUnique({ where: { txRef } });
    if (!payment) {
      this.logger.warn(`Verification requested for unknown txRef ${txRef} (${reason})`);
      return 'unknown_payment';
    }
    if (payment.status === 'REFUNDED' || payment.status === 'REVERSED') return 'already_final';
    if (payment.status === 'FAILED' && payment.failureReason?.startsWith('initialize_failed')) return 'already_final';

    let verified: VerifiedTransaction;
    try {
      verified = await this.gateways.get(payment.gateway).verify(txRef);
    } catch (error) {
      if (error instanceof GatewayError && !error.retryable) {
        this.logger.error(`Non-retryable verify error for ${txRef}: ${error.message}`);
        return 'still_pending';
      }
      throw error;
    }

    switch (verified.status) {
      case 'succeeded':
        return this.settleSuccess(payment, verified, reason);
      case 'failed':
        return this.markFailed(payment, verified);
      case 'refunded':
      case 'reversed':
        return this.settleRefund(payment, verified);
      case 'pending':
        if (payment.status === 'PENDING' && Date.now() - payment.createdAt.getTime() > PENDING_EXPIRY_MS) {
          await this.prisma.tenant(payment.schoolId, (tx) =>
            tx.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: 'expired' } }),
          );
          return 'expired';
        }
        return 'still_pending';
    }
  }

  private async lockPayment(tx: Tx, paymentId: string): Promise<Payment> {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`;
    return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  private async openIssue(tx: Tx, payment: Payment, kind: string, details: Prisma.InputJsonValue): Promise<void> {
    await tx.reconciliationIssue.create({
      data: { schoolId: payment.schoolId, kind, txRef: payment.txRef, gatewayReference: payment.gatewayReference, details },
    });
  }

  private async settleSuccess(
    payment: Payment,
    verified: VerifiedTransaction,
    reason: VerifyPaymentJob['reason'],
  ): Promise<SettlementOutcome> {
    const outcome = await this.prisma.tenant(payment.schoolId, async (tx): Promise<SettlementOutcome> => {
      const current = await this.lockPayment(tx, payment.id);
      if (current.status === 'SUCCEEDED' || current.status === 'REVIEW') return 'already_final';

      const raw = JSON.parse(JSON.stringify(verified.raw ?? null)) as Prisma.InputJsonValue;
      if (verified.amount !== current.amount || verified.currency !== current.currency) {
        await tx.payment.update({
          where: { id: current.id },
          data: {
            status: 'REVIEW',
            reviewReason: `amount_mismatch: expected ${current.amount} ${current.currency}, gateway reported ${verified.amount} ${verified.currency}`,
            gatewayReference: verified.gatewayReference,
            method: verified.method,
            rawVerifyResponse: raw,
            verifiedAt: new Date(),
          },
        });
        await this.openIssue(tx, current, 'amount_mismatch', { expected: current.amount, reported: verified.amount, currency: verified.currency });
        return 'review';
      }

      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${current.invoiceId} FOR UPDATE`;
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: current.invoiceId } });
      if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
        await tx.payment.update({
          where: { id: current.id },
          data: {
            status: 'REVIEW',
            reviewReason: `invoice_not_payable: invoice is ${invoice.status}; refund required`,
            gatewayReference: verified.gatewayReference,
            method: verified.method,
            rawVerifyResponse: raw,
            verifiedAt: new Date(),
          },
        });
        await this.openIssue(tx, current, 'duplicate_or_late_payment', { invoiceStatus: invoice.status, amount: current.amount });
        return 'review';
      }

      const now = new Date();
      const gatewayFee = verified.fee ?? 0;
      const platformFee = this.platformFeeFor(current.amount);
      await tx.payment.update({
        where: { id: current.id },
        data: {
          status: 'SUCCEEDED',
          gatewayReference: verified.gatewayReference,
          method: verified.method,
          gatewayFee,
          platformFee,
          rawVerifyResponse: raw,
          verifiedAt: now,
          succeededAt: now,
        },
      });
      const paidAmount = invoice.paidAmount + current.amount;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidAmount,
          status: paidAmount >= invoice.totalAmount ? 'PAID' : 'PARTIALLY_PAID',
          paidAt: paidAmount >= invoice.totalAmount ? now : null,
        },
      });
      await this.ledger.paymentSucceeded(tx, {
        schoolId: current.schoolId,
        invoiceId: invoice.id,
        paymentId: current.id,
        amount: current.amount,
        gatewayFee,
        platformFee,
        memo: `Payment ${current.txRef} for invoice ${invoice.number}`,
      });
      await this.audit.record(
        {
          schoolId: current.schoolId,
          actorType: 'gateway',
          actorId: current.gateway,
          action: 'payment.succeeded',
          entityType: 'Payment',
          entityId: current.id,
          metadata: { txRef: current.txRef, amount: current.amount, reference: verified.gatewayReference, via: reason },
        },
        tx,
      );
      return 'succeeded';
    });

    if (outcome === 'succeeded') {
      await this.queues.add(QUEUES.receipts, JOBS.issueReceipt, { paymentId: payment.id }, { jobId: `receipt-${payment.id}` });
      await this.outbound.emit(payment.schoolId, 'payment.succeeded', { txRef: payment.txRef, paymentId: payment.id, invoiceId: payment.invoiceId, amount: payment.amount, currency: payment.currency });
    }
    return outcome;
  }

  private async markFailed(payment: Payment, verified: VerifiedTransaction): Promise<SettlementOutcome> {
    const changed = await this.prisma.tenant(payment.schoolId, async (tx) => {
      const result = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          failureReason: 'gateway_reported_failed',
          rawVerifyResponse: JSON.parse(JSON.stringify(verified.raw ?? null)) as Prisma.InputJsonValue,
          verifiedAt: new Date(),
        },
      });
      if (result.count > 0) {
        await this.audit.record(
          { schoolId: payment.schoolId, actorType: 'gateway', actorId: payment.gateway, action: 'payment.failed', entityType: 'Payment', entityId: payment.id, metadata: { txRef: payment.txRef } },
          tx,
        );
      }
      return result.count > 0;
    });
    if (changed) {
      await this.outbound.emit(payment.schoolId, 'payment.failed', { txRef: payment.txRef, paymentId: payment.id, invoiceId: payment.invoiceId });
    }
    return changed ? 'failed' : 'already_final';
  }

  private async settleRefund(payment: Payment, verified: VerifiedTransaction): Promise<SettlementOutcome> {
    const outcome = await this.prisma.tenant(payment.schoolId, async (tx): Promise<SettlementOutcome> => {
      const current = await this.lockPayment(tx, payment.id);
      if (current.status !== 'SUCCEEDED') return 'already_final';
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${current.invoiceId} FOR UPDATE`;
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: current.invoiceId } });
      const paidAmount = Math.max(0, invoice.paidAmount - current.amount);
      await tx.payment.update({
        where: { id: current.id },
        data: { status: verified.status === 'reversed' ? 'REVERSED' : 'REFUNDED', rawVerifyResponse: JSON.parse(JSON.stringify(verified.raw ?? null)) as Prisma.InputJsonValue },
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount, status: paidAmount === 0 ? 'REFUNDED' : 'PARTIALLY_PAID', paidAt: null },
      });
      await this.ledger.paymentRefunded(tx, {
        schoolId: current.schoolId,
        invoiceId: invoice.id,
        paymentId: current.id,
        amount: current.amount,
        memo: `${verified.status === 'reversed' ? 'Reversal' : 'Refund'} of ${current.txRef}`,
      });
      await this.audit.record(
        { schoolId: current.schoolId, actorType: 'gateway', actorId: current.gateway, action: `payment.${verified.status}`, entityType: 'Payment', entityId: current.id, metadata: { txRef: current.txRef, amount: current.amount } },
        tx,
      );
      return 'refunded';
    });
    if (outcome === 'refunded') {
      await this.outbound.emit(payment.schoolId, 'payment.refunded', { txRef: payment.txRef, paymentId: payment.id, invoiceId: payment.invoiceId, amount: payment.amount });
    }
    return outcome;
  }

  async listForSchool(schoolId: string, filter: { status?: string; page: number; pageSize: number }) {
    const where: Prisma.PaymentWhereInput = { schoolId };
    if (filter.status) where.status = filter.status as Payment['status'];
    return this.prisma.tenant(schoolId, async (tx) => {
      const items = await tx.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        include: {
          invoice: { select: { number: true, student: { select: { firstName: true, lastName: true, code: true } } } },
          receipt: { select: { id: true, receiptNo: true } },
        },
      });
      const total = await tx.payment.count({ where });
      return { items, total, page: filter.page, pageSize: filter.pageSize };
    });
  }

  async getForSchool(schoolId: string, paymentId: string) {
    const payment = await this.prisma.tenant(schoolId, (tx) =>
      tx.payment.findFirst({
        where: { id: paymentId, schoolId },
        include: { invoice: { include: { student: true } }, receipt: true },
      }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }
}
