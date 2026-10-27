import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type Payment } from '@payment/db';
import type { AttachPaymentInput, PayerMethod, StartPaymentInput, StartPaymentResult } from '@payment/shared';
import type { Job } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { randomReference, SecretBox } from '../common/crypto.util';
import type { Principal } from '../common/principal';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { GatewayError, type DirectPayBeneficiary, type VerifiedTransaction } from '../gateways/payment-gateway.interface';
import { OutboundWebhooksService } from '../integrations/outbound-webhooks.service';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { JOBS, QUEUES, type VerifyPaymentJob } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/**
 * Hosted Chapa checkout stays open after a declined card. Rechecking the declined tx_ref inside
 * this window catches a late status change on that same reference. A retry made on Chapa's own
 * page, however, is a new Chapa transaction with a reference this app never issued; verify of
 * the original tx_ref keeps reporting failed/cancelled for it (confirmed against the live test
 * API on 2026-10-21). Such a success is linked through attachVerifiedTransaction.
 */
export const CHECKOUT_RETRY_WINDOW_MS = 30 * 60 * 1000;
const REUSE_CHECKOUT_WINDOW_MS = CHECKOUT_RETRY_WINDOW_MS;
const PHONE_PROMPT_WINDOW_MS = 30 * 60 * 1000;
const PHONE_PROMPT_UNAVAILABLE = 'We could not send the request to your phone. Please try again in a few minutes.';
const PENDING_EXPIRY_MS = 24 * 3600 * 1000;
const CARD_RETRY_DELAYS_MS = [45_000, 3 * 60_000, 10 * 60_000];

type PayableInvoice = Prisma.InvoiceGetPayload<{ include: { school: true; student: true; lines: true } }>;

function isPendingInvoiceConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.['target'];
  const label = Array.isArray(target) ? target.map(String).join(' ') : String(target ?? '');
  return label.includes('payment_one_pending_per_invoice') || error.message.includes('payment_one_pending_per_invoice');
}

function payerMethodOf(value: string | null | undefined): PayerMethod {
  return value === 'cbe_birr' ? 'cbe_birr' : 'telebirr';
}

export type SettlementOutcome =
  | 'unknown_payment'
  | 'already_final'
  | 'already_failed'
  | 'still_pending'
  | 'succeeded'
  | 'failed'
  | 'review'
  | 'refunded'
  | 'expired'
  | 'rejected';

/** A gateway decline can still succeed later on the same checkout. Initialization failures cannot. */
export function shouldRecheckFailedPayment(
  payment: { status: string; failureReason: string | null; createdAt: Date },
  now = Date.now(),
): boolean {
  return (
    payment.status === 'FAILED' &&
    payment.failureReason === 'gateway_reported_failed' &&
    now - payment.createdAt.getTime() < CHECKOUT_RETRY_WINDOW_MS
  );
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts.shift() ?? 'Parent';
  return { firstName, lastName: parts.join(' ') || firstName };
}

/** Chapa's verify payload is the payer who actually completed checkout, who may not be the parent who opened it. */
function observedPayer(verified: VerifiedTransaction): { payerName?: string; payerPhone?: string; payerEmail?: string } {
  const name = verified.payer?.name?.trim();
  const phone = verified.payer?.phone?.trim();
  const email = verified.payer?.email?.trim();
  return {
    ...(name ? { payerName: name } : {}),
    ...(phone ? { payerPhone: phone } : {}),
    ...(email ? { payerEmail: email } : {}),
  };
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
    private readonly secrets: SecretBox,
  ) {}

  onModuleInit(): void {
    this.queues.register(QUEUES.payments, JOBS.verifyPayment, async (job: Job<VerifyPaymentJob>) =>
      this.verifyAndSettle(job.data.txRef, job.data.reason),
    );
  }

  async enqueueVerification(txRef: string, reason: VerifyPaymentJob['reason'], delayMs = 0, jobId?: string): Promise<void> {
    await this.queues.add<VerifyPaymentJob>(QUEUES.payments, JOBS.verifyPayment, { txRef, reason }, {
      delay: delayMs,
      jobId: jobId ?? (delayMs > 0 ? `verify-${txRef}-${Date.now() + delayMs}` : undefined),
    });
  }

  platformFeeFor(amount: number): number {
    if (this.env.PLATFORM_FEE_VALUE <= 0) return 0;
    if (this.env.PLATFORM_FEE_TYPE === 'flat') return Math.round(this.env.PLATFORM_FEE_VALUE * 100);
    return Math.round(amount * this.env.PLATFORM_FEE_VALUE);
  }

  /** Public pay page: creates (or reuses) a payment attempt and returns a phone prompt or a hosted checkout. */
  async start(payToken: string, input: StartPaymentInput, ip?: string): Promise<StartPaymentResult> {
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
    if (gateway.name === 'arifpay') {
      return this.startPhonePrompt(payToken, invoice, input, amount, ip);
    }
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
    if (reusable?.checkoutUrl) return { kind: 'redirect', txRef: reusable.txRef, checkoutUrl: reusable.checkoutUrl };

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
      return { kind: 'redirect', txRef, checkoutUrl: result.checkoutUrl };
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
   * Telebirr and CBE Birr stay on our page. One invoice has one open attempt. A repeat of the
   * same amount and method re-sends the phone prompt on that nonce. A method change or an
   * expired session is verified first, and a paid result is settled instead of replaced.
   */
  private async startPhonePrompt(
    payToken: string,
    invoice: PayableInvoice,
    input: StartPaymentInput,
    amount: number,
    ip?: string,
  ): Promise<StartPaymentResult> {
    if (!invoice.school.payoutBankCode?.trim() || !invoice.school.payoutAccountEncrypted?.trim()) {
      throw new BadRequestException('This school has not finished its payout setup');
    }

    const pending = await this.prisma.db.payment.findFirst({
      where: { invoiceId: invoice.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) {
      const expired = pending.sessionExpiresAt != null && pending.sessionExpiresAt.getTime() <= Date.now();
      const sameAttempt = !expired && pending.amount === amount && pending.payerMethod === input.method;
      if (sameAttempt) {
        return this.dispatchPhonePrompt(payToken, invoice, pending, input);
      }
      const kept = await this.closeOpenAttempt(pending, expired ? 'expired' : pending.payerMethod !== input.method ? 'superseded_by_method_change' : 'superseded_by_amount_change');
      if (kept) return this.phonePromptView(kept);
    }

    return this.createPhoneAttempt(payToken, invoice, input, amount, ip);
  }

  private async closeOpenAttempt(payment: Payment, failureReason: string): Promise<Payment | null> {
    let outcome: SettlementOutcome;
    try {
      outcome = await this.verifyAndSettle(payment.txRef, 'sweep');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not verify ${payment.txRef} before opening another attempt: ${message}`);
      throw new BadGatewayException(PHONE_PROMPT_UNAVAILABLE);
    }
    const current = await this.prisma.db.payment.findUnique({ where: { id: payment.id } });
    if (!current) return payment;
    if (outcome === 'succeeded' || outcome === 'review' || outcome === 'refunded' || current.status === 'SUCCEEDED' || current.status === 'REVIEW' || current.status === 'REFUNDED' || current.status === 'REVERSED') {
      return current;
    }
    await this.failPending(current, failureReason);
    const after = await this.prisma.db.payment.findUnique({ where: { id: payment.id } });
    if (after && after.status !== 'FAILED') return after;
    return null;
  }

  private async failPending(payment: Payment, failureReason: string): Promise<void> {
    await this.prisma.tenant(payment.schoolId, async (tx) => {
      const pending = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED', failureReason },
      });
      if (pending.count === 0) {
        await tx.payment.updateMany({
          where: { id: payment.id, status: 'FAILED' },
          data: { failureReason },
        });
      }
    });
  }

  private async createPhoneAttempt(
    payToken: string,
    invoice: PayableInvoice,
    input: StartPaymentInput,
    amount: number,
    ip?: string,
  ): Promise<StartPaymentResult> {
    const txRef = `${invoice.school.code}-${randomReference(14)}`;
    try {
      const payment = await this.prisma.tenant(invoice.schoolId, async (tx) => {
        const created = await tx.payment.create({
          data: {
            schoolId: invoice.schoolId,
            invoiceId: invoice.id,
            txRef,
            gateway: 'arifpay',
            amount,
            currency: invoice.currency,
            payerName: input.payerName,
            payerPhone: input.payerPhone,
            payerEmail: input.payerEmail,
            payerMethod: input.method,
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
            metadata: { txRef, amount, invoiceNumber: invoice.number, method: input.method },
            ip,
          },
          tx,
        );
        return created;
      });
      return this.dispatchPhonePrompt(payToken, invoice, payment, input);
    } catch (error) {
      if (!isPendingInvoiceConflict(error)) throw error;
      const winner = await this.prisma.db.payment.findFirst({
        where: { invoiceId: invoice.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      if (!winner) throw error;
      return this.dispatchPhonePrompt(payToken, invoice, winner, { ...input, method: payerMethodOf(winner.payerMethod) });
    }
  }

  private payoutBeneficiary(school: PayableInvoice['school'], amount: number): DirectPayBeneficiary {
    if (!school.payoutBankCode || !school.payoutAccountEncrypted) {
      throw new BadRequestException('This school has not finished its payout setup');
    }
    let accountNumber: string;
    try {
      accountNumber = this.secrets.decrypt(school.payoutAccountEncrypted).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Payout account could not be read: ${message}`);
      throw new BadRequestException('This school has not finished its payout setup');
    }
    if (!accountNumber) throw new BadRequestException('This school has not finished its payout setup');
    return { accountNumber, bank: school.payoutBankCode, amount };
  }

  private phonePromptView(payment: Payment): StartPaymentResult {
    return {
      kind: 'phone_prompt',
      txRef: payment.txRef,
      method: payerMethodOf(payment.payerMethod),
      expiresAt: (payment.sessionExpiresAt ?? new Date(Date.now() + PHONE_PROMPT_WINDOW_MS)).toISOString(),
    };
  }

  private async dispatchPhonePrompt(
    payToken: string,
    invoice: PayableInvoice,
    payment: Payment,
    input: StartPaymentInput,
  ): Promise<StartPaymentResult> {
    const gateway = this.gateways.get(payment.gateway);
    if (!gateway.directPay) throw new BadGatewayException(PHONE_PROMPT_UNAVAILABLE);
    const expiresAt = payment.sessionExpiresAt ?? new Date(Date.now() + PHONE_PROMPT_WINDOW_MS);
    const email = input.payerEmail ?? this.env.ARIFPAY_FALLBACK_EMAIL ?? invoice.school.contactEmail;
    try {
      const result = await gateway.directPay({
        txRef: payment.txRef,
        amount: payment.amount,
        currency: 'ETB',
        method: input.method,
        phone: input.payerPhone,
        email,
        notifyUrl: `${this.env.API_PUBLIC_URL}/webhooks/arifpay`,
        returnUrl: `${this.env.WEB_URL}/pay/${payToken}/return?tx=${encodeURIComponent(payment.txRef)}`,
        title: 'School Fees',
        description: `${invoice.school.code} ${invoice.number}`,
        expiresAt,
        beneficiary: this.payoutBeneficiary(invoice.school, payment.amount),
      });
      await this.prisma.tenant(invoice.schoolId, (tx) =>
        tx.payment.update({
          where: { id: payment.id },
          data: { gatewaySessionId: result.sessionId, sessionExpiresAt: new Date(result.expiresAt) },
        }),
      );
      if (result.alreadySucceeded) {
        await this.verifyAndSettle(payment.txRef, 'sweep');
        return this.phonePromptView({ ...payment, payerMethod: input.method, sessionExpiresAt: new Date(result.expiresAt) });
      }
      if (result.alreadyFailed) {
        await this.failPending(payment, 'gateway_reported_failed');
        throw new BadGatewayException(PHONE_PROMPT_UNAVAILABLE);
      }
      await this.enqueueVerification(payment.txRef, 'sweep', 15 * 60 * 1000);
      return { kind: 'phone_prompt', txRef: payment.txRef, method: input.method, expiresAt: result.expiresAt };
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Phone prompt failed for ${payment.txRef}: ${message}`);
      const current = await this.prisma.db.payment.findUnique({ where: { id: payment.id } });
      if (current?.gatewaySessionId) throw new BadGatewayException(PHONE_PROMPT_UNAVAILABLE);
      await this.prisma.tenant(invoice.schoolId, (tx) =>
        tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'FAILED', failureReason: 'initialize_failed' },
        }),
      );
      throw new BadGatewayException(PHONE_PROMPT_UNAVAILABLE);
    }
  }

  /**
   * The only path that changes a payment's money state. Always re-queries the gateway, then
   * applies the result inside one transaction with row locks so concurrent webhooks, callbacks
   * and sweeps cannot double-settle.
   *
   * If the gateway later reports success for a tx_ref that was first seen as failed, that later
   * success is applied. A failed or pending verify never pays the invoice, and it never
   * downgrades a payment that already succeeded. A success the gateway recorded under a tx_ref
   * this app never issued is not reachable from here (unknown_payment); staff link it with
   * attachVerifiedTransaction.
   */
  async verifyAndSettle(txRef: string, reason: VerifyPaymentJob['reason']): Promise<SettlementOutcome> {
    const payment = await this.prisma.db.payment.findUnique({ where: { txRef } });
    if (!payment) {
      this.logger.warn(`Verification requested for unknown txRef ${txRef} (${reason})`);
      return 'unknown_payment';
    }
    if (payment.status === 'REFUNDED' || payment.status === 'REVERSED') return 'already_final';
    if (payment.status === 'FAILED' && payment.failureReason?.startsWith('initialize_failed')) return 'already_final';

    const gateway = this.gateways.get(payment.gateway);
    let verified: VerifiedTransaction;
    try {
      verified =
        payment.gatewaySessionId && gateway.verifySession
          ? await gateway.verifySession(payment.gatewaySessionId, payment.txRef)
          : await gateway.verify(txRef);
    } catch (error) {
      if (error instanceof GatewayError && !error.retryable) {
        this.logger.error(`Non-retryable verify error for ${txRef}: ${error.message}`);
        return 'still_pending';
      }
      throw error;
    }
    if (verified.txRef !== payment.txRef) {
      this.logger.error(`Refusing to settle ${payment.txRef}: verification returned ${verified.txRef}`);
      return 'rejected';
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

  /**
   * Staff-driven link between an invoice and a gateway transaction this app did not initialize,
   * such as a card retry completed on the provider's hosted checkout under a provider-generated
   * tx_ref. The merchant reference comes from the provider dashboard. Nothing is written until
   * the provider's verify call confirms a succeeded transaction whose tx_ref, amount and
   * currency match this invoice's outstanding balance; settlement then runs through the same
   * locked path as every other success, so ledger, audit, receipt and outbound events are
   * produced exactly once. Re-submitting the same reference re-verifies instead of duplicating.
   */
  async attachVerifiedTransaction(
    schoolId: string,
    input: AttachPaymentInput,
    principal: Principal,
    ip?: string,
  ): Promise<{ outcome: SettlementOutcome; paymentId: string; txRef: string }> {
    const invoice = await this.prisma.tenant(schoolId, (tx) =>
      tx.invoice.findFirst({ where: { id: input.invoiceId, schoolId }, include: { school: true, student: true } }),
    );
    if (!invoice) throw new NotFoundException('Invoice not found');

    const existing = await this.prisma.db.payment.findUnique({ where: { txRef: input.txRef } });
    if (existing) {
      if (existing.schoolId !== schoolId || existing.invoiceId !== invoice.id) {
        throw new ConflictException('This merchant reference already belongs to a different payment');
      }
      const outcome = await this.verifyAndSettle(existing.txRef, 'manual');
      return { outcome, paymentId: existing.id, txRef: existing.txRef };
    }

    if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
      throw new BadRequestException(`This invoice is ${invoice.status.toLowerCase().replace('_', ' ')} and cannot take a payment`);
    }
    const balance = invoice.totalAmount - invoice.paidAmount;
    if (balance <= 0) throw new BadRequestException('Nothing left to pay on this invoice');

    const gateway = this.gateways.default();
    let verified: VerifiedTransaction;
    try {
      verified = await gateway.verify(input.txRef);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Attach verify failed for ${input.txRef}: ${message}`);
      throw new BadGatewayException('Could not reach the payment provider to verify this reference. Try again shortly.');
    }
    if (verified.txRef !== input.txRef) {
      throw new BadRequestException('The payment provider returned a different merchant reference');
    }
    if (verified.status !== 'succeeded') {
      throw new BadRequestException(
        verified.status === 'pending'
          ? 'The payment provider does not report a completed transaction for this reference. Check the reference and the provider dashboard.'
          : `The payment provider reports this reference as ${verified.status}; only a successful transaction can be attached`,
      );
    }
    if (verified.amount !== balance || verified.currency !== invoice.currency) {
      throw new BadRequestException(
        `The provider reports ${verified.amount} ${verified.currency} (santim) but this invoice balance is ${balance} ${invoice.currency}. Amounts must match exactly.`,
      );
    }
    if (verified.gatewayReference) {
      const recorded = await this.prisma.db.payment.findUnique({ where: { gatewayReference: verified.gatewayReference } });
      if (recorded) throw new ConflictException('This provider transaction is already recorded as a payment');
    }

    const payerName = verified.payer?.name ?? `${invoice.student.firstName} ${invoice.student.lastName}`.trim();
    const payerPhone = verified.payer?.phone ?? '';
    const payment = await this.prisma.tenant(schoolId, async (tx) => {
      const created = await tx.payment.create({
        data: {
          schoolId,
          invoiceId: invoice.id,
          txRef: input.txRef,
          gateway: gateway.name,
          amount: balance,
          currency: invoice.currency,
          payerName,
          payerPhone,
          payerEmail: verified.payer?.email ?? null,
        },
      });
      await this.audit.record(
        {
          schoolId,
          principal,
          action: 'payment.attached',
          entityType: 'Payment',
          entityId: created.id,
          metadata: { txRef: input.txRef, amount: balance, invoiceNumber: invoice.number, reference: verified.gatewayReference },
          ip,
        },
        tx,
      );
      return created;
    });

    const outcome = await this.settleSuccess(payment, verified, 'manual');
    return { outcome, paymentId: payment.id, txRef: payment.txRef };
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
      if (current.status === 'SUCCEEDED' || current.status === 'REVIEW' || current.status === 'REFUNDED' || current.status === 'REVERSED') {
        return 'already_final';
      }
      if (current.invoiceId !== payment.invoiceId || current.txRef !== payment.txRef) return 'rejected';

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
          failureReason: null,
          rawVerifyResponse: raw,
          verifiedAt: now,
          succeededAt: now,
          ...observedPayer(verified),
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
    const outcome = await this.prisma.tenant(payment.schoolId, async (tx): Promise<SettlementOutcome> => {
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
        return 'failed';
      }
      const current = await tx.payment.findUnique({ where: { id: payment.id }, select: { status: true } });
      return current?.status === 'FAILED' ? 'already_failed' : 'already_final';
    });
    if (outcome === 'failed') {
      await this.outbound.emit(payment.schoolId, 'payment.failed', { txRef: payment.txRef, paymentId: payment.id, invoiceId: payment.invoiceId });
    }
    if (outcome === 'failed' || outcome === 'already_failed') {
      const failureReason = outcome === 'failed' ? 'gateway_reported_failed' : payment.failureReason;
      if (failureReason === 'gateway_reported_failed') await this.scheduleCardRetryChecks(payment.txRef, payment.createdAt);
    }
    return outcome;
  }

  /**
   * The failure webhook often arrives before the customer finishes a card retry on the same
   * checkout. These delayed verifies observe a later success without trusting the webhook body.
   * Job ids are stable so a repeated failure does not queue a second copy.
   */
  private async scheduleCardRetryChecks(txRef: string, createdAt: Date): Promise<void> {
    const ageMs = Date.now() - createdAt.getTime();
    if (ageMs >= CHECKOUT_RETRY_WINDOW_MS) return;
    for (const delayMs of CARD_RETRY_DELAYS_MS) {
      if (ageMs + delayMs >= CHECKOUT_RETRY_WINDOW_MS) continue;
      await this.enqueueVerification(txRef, 'sweep', delayMs, `card-retry-${txRef}-${delayMs}`);
    }
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
