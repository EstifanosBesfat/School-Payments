import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { IssueStatus, Prisma } from '@payment/db';
import type { Principal } from '../common/principal';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { GatewayError, type GatewayTransactionSummary, type VerifiedTransaction } from '../gateways/payment-gateway.interface';
import { PaymentLockService } from '../payments/payment-lock.service';
import { CHECKOUT_RETRY_WINDOW_MS, PaymentsService } from '../payments/payments.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { JOBS, QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { AuditService } from '../audit/audit.service';
import { gatewayPayloadClaimsSuccess } from '../webhooks/webhooks.service';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GATEWAY_WINDOW_MS = 3 * DAY;
const MAX_GATEWAY_PAGES = 50;
const SWEEP_BATCH = 500;

export interface ReconciliationSummary {
  runId: string;
  checked: number;
  issues: number;
  settledLate: number;
  receiptsRequeued: number;
}

@Injectable()
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly gateways: GatewayRegistry,
    private readonly payments: PaymentsService,
    private readonly receipts: ReceiptsService,
    private readonly audit: AuditService,
    private readonly locks: PaymentLockService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queues.register(QUEUES.maintenance, JOBS.reconcile, () => this.run());
    this.queues.register(QUEUES.maintenance, JOBS.sweepPendingPayments, () => this.sweepPending());
    this.queues.register(QUEUES.maintenance, JOBS.cleanup, () => this.cleanup());
    if (this.env.RUN_WORKERS) {
      await this.queues.schedule(QUEUES.maintenance, 'nightly-reconciliation', '30 2 * * *', JOBS.reconcile);
      await this.queues.schedule(QUEUES.maintenance, 'pending-payment-sweep', '*/5 * * * *', JOBS.sweepPendingPayments);
      await this.queues.schedule(QUEUES.maintenance, 'daily-cleanup', '0 3 * * *', JOBS.cleanup);
    }
  }

  /**
   * Anti-entropy pass for hosted checkout. Chapa can show a transaction as successful while the
   * webhook never arrives, because the payer left through another redirect or a retry loop in
   * Chapa's page. Every five minutes this queues a gateway verify for PENDING attempts older
   * than ten minutes, and for card declines that can still succeed on the same tx_ref.
   * Each verify calls the provider (Chapa GET /transaction/verify/{txRef}). Only that verified
   * result can mark the payment succeeded, store the provider reference and payer, and issue
   * the receipt. A tx_ref already locked by an in-flight webhook is left for that webhook.
   */
  async sweepPending(): Promise<{ queued: number; skippedLocked: number }> {
    const now = Date.now();
    const pending = await this.prisma.db.payment.findMany({
      where: {
        OR: [
          { status: 'PENDING', createdAt: { lt: new Date(now - 10 * MINUTE) } },
          {
            status: 'FAILED',
            failureReason: 'gateway_reported_failed',
            createdAt: { gt: new Date(now - CHECKOUT_RETRY_WINDOW_MS) },
          },
        ],
      },
      select: { txRef: true },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
    });
    let queued = 0;
    let skippedLocked = 0;
    for (const payment of pending) {
      const acquired = await this.locks.acquire(payment.txRef);
      if (!acquired) {
        skippedLocked += 1;
        this.logger.warn(`Skipping sweep for ${payment.txRef}; verification is already in progress`);
        continue;
      }
      await this.payments.enqueueVerification(payment.txRef, 'sweep');
      queued += 1;
    }
    if (queued > 0 || skippedLocked > 0) {
      this.logger.log(`Pending sweep queued ${queued} verification${queued === 1 ? '' : 's'} and skipped ${skippedLocked} locked tx_ref${skippedLocked === 1 ? '' : 's'}`);
    }
    return { queued, skippedLocked };
  }

  async run(): Promise<ReconciliationSummary> {
    const run = await this.prisma.db.reconciliationRun.create({ data: {} });
    let checked = 0;
    let issues = 0;
    let settledLate = 0;
    let receiptsRequeued = 0;
    const openIssue = async (data: { schoolId?: string | null; kind: string; txRef?: string | null; gatewayReference?: string | null; details: Prisma.InputJsonObject }) => {
      const duplicate = await this.prisma.db.reconciliationIssue.findFirst({
        where: { kind: data.kind, txRef: data.txRef ?? null, gatewayReference: data.gatewayReference ?? null, status: 'OPEN' },
        select: { id: true },
      });
      if (duplicate) return;
      await this.prisma.db.reconciliationIssue.create({ data: { ...data, runId: run.id } });
      issues += 1;
    };

    try {
      const stale = await this.prisma.db.payment.findMany({
        where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - HOUR) } },
        select: { txRef: true },
        take: 5000,
      });
      for (const payment of stale) {
        checked += 1;
        const outcome = await this.payments.verifyAndSettle(payment.txRef, 'sweep').catch((error: Error) => {
          this.logger.warn(`Reconcile verify ${payment.txRef} failed: ${error.message}`);
          return 'error' as const;
        });
        if (outcome === 'succeeded') settledLate += 1;
      }

      for (const gatewayName of this.gateways.names()) {
        const result = await this.compareWithGateway(gatewayName, openIssue);
        checked += result.checked;
        settledLate += result.settledLate;
      }

      const missingReceipts = await this.prisma.db.payment.findMany({
        where: { status: 'SUCCEEDED', receipt: null, succeededAt: { lt: new Date(Date.now() - 10 * MINUTE) } },
        select: { id: true },
        take: 1000,
      });
      for (const payment of missingReceipts) {
        await this.queues.add(QUEUES.receipts, JOBS.issueReceipt, { paymentId: payment.id }, { jobId: `receipt-${payment.id}-recon-${run.id}` });
        receiptsRequeued += 1;
      }
      const missingPdfs = await this.prisma.db.receipt.findMany({
        where: { pdfKey: null, issuedAt: { lt: new Date(Date.now() - 10 * MINUTE) } },
        select: { id: true },
        take: 1000,
      });
      for (const receipt of missingPdfs) {
        await this.queues.add(QUEUES.receipts, JOBS.renderReceiptPdf, { receiptId: receipt.id }, { jobId: `pdf-${receipt.id}-recon-${run.id}` });
        receiptsRequeued += 1;
      }

      const schools = await this.prisma.db.school.findMany({ where: { receiptSeq: { gt: 0 } }, select: { id: true } });
      for (const school of schools) {
        const chain = await this.receipts.verifyChain(school.id);
        if (!chain.valid) {
          await openIssue({ schoolId: school.id, kind: 'receipt_chain_broken', details: { problems: chain.problems.slice(0, 50), receipts: chain.receipts } });
        }
      }

      await this.prisma.db.reconciliationRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), checkedCount: checked, issueCount: issues } });
      this.logger.log(`Reconciliation ${run.id}: checked ${checked}, issues ${issues}, settled late ${settledLate}, receipts requeued ${receiptsRequeued}`);
      return { runId: run.id, checked, issues, settledLate, receiptsRequeued };
    } catch (error) {
      await this.prisma.db.reconciliationRun.update({
        where: { id: run.id },
        data: { finishedAt: new Date(), checkedCount: checked, issueCount: issues, error: (error as Error).message.slice(0, 1000) },
      });
      throw error;
    }
  }

  /** Every successful gateway transaction must match a SUCCEEDED payment with the same amount. */
  private async compareWithGateway(
    gatewayName: string,
    openIssue: (data: { schoolId?: string | null; kind: string; txRef?: string | null; gatewayReference?: string | null; details: Prisma.InputJsonObject }) => Promise<void>,
  ): Promise<{ checked: number; settledLate: number }> {
    const gateway = this.gateways.get(gatewayName);
    const since = Date.now() - GATEWAY_WINDOW_MS;
    const seen: GatewayTransactionSummary[] = [];
    let complete = false;
    try {
      for (let page = 1; page <= MAX_GATEWAY_PAGES; page += 1) {
        const { transactions, hasMore } = await gateway.listTransactions(page);
        seen.push(...transactions);
        const reachedWindowStart = transactions.some((tx) => new Date(tx.createdAt).getTime() < since);
        if (!hasMore || reachedWindowStart) {
          complete = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof GatewayError && !error.retryable && gateway.verifySession) {
        return this.compareBySession(gateway, openIssue);
      }
      this.logger.warn(`Could not list ${gatewayName} transactions: ${(error as Error).message}`);
      await openIssue({ kind: 'gateway_unreachable', gatewayReference: `${gatewayName}-${new Date().toISOString().slice(0, 10)}`, details: { gateway: gatewayName, error: (error as Error).message } });
      return { checked: 0, settledLate: 0 };
    }

    let checked = 0;
    let settledLate = 0;
    // listTransactions maps Chapa's "success" to "succeeded" before this comparison.
    const successful = seen.filter((tx) => tx.status === 'succeeded' && new Date(tx.createdAt).getTime() >= since);
    const seenRefs = new Set<string>();
    for (const tx of successful) {
      checked += 1;
      if (!tx.txRef) {
        await openIssue({ kind: 'gateway_tx_without_reference', gatewayReference: tx.reference, details: { ...tx } });
        continue;
      }
      seenRefs.add(tx.txRef);
      let payment = await this.prisma.db.payment.findUnique({ where: { txRef: tx.txRef } });
      if (!payment) {
        await openIssue({ kind: 'gateway_tx_unknown', txRef: tx.txRef, gatewayReference: tx.reference, details: { ...tx, gateway: gatewayName } });
        continue;
      }
      if (payment.status === 'PENDING' || payment.status === 'FAILED') {
        const outcome = await this.payments.verifyAndSettle(tx.txRef, 'sweep').catch(() => 'error' as const);
        if (outcome === 'succeeded') settledLate += 1;
        payment = await this.prisma.db.payment.findUniqueOrThrow({ where: { txRef: tx.txRef } });
      }
      if (payment.status !== 'SUCCEEDED' && payment.status !== 'REFUNDED' && payment.status !== 'REVERSED') {
        await openIssue({ schoolId: payment.schoolId, kind: 'status_mismatch', txRef: tx.txRef, gatewayReference: tx.reference, details: { gatewayStatus: tx.status, localStatus: payment.status, amount: tx.amount } });
      } else if (payment.amount !== tx.amount || payment.currency !== tx.currency) {
        await openIssue({ schoolId: payment.schoolId, kind: 'amount_mismatch', txRef: tx.txRef, gatewayReference: tx.reference, details: { gatewayAmount: tx.amount, localAmount: payment.amount, gatewayCurrency: tx.currency } });
      }
    }

    if (complete) {
      const localSucceeded = await this.prisma.db.payment.findMany({
        where: { gateway: gatewayName, status: 'SUCCEEDED', succeededAt: { gte: new Date(since + HOUR), lt: new Date(Date.now() - HOUR) } },
        select: { txRef: true, schoolId: true, amount: true, gatewayReference: true },
      });
      for (const payment of localSucceeded) {
        if (!seenRefs.has(payment.txRef)) {
          await openIssue({ schoolId: payment.schoolId, kind: 'missing_at_gateway', txRef: payment.txRef, gatewayReference: payment.gatewayReference, details: { amount: payment.amount, gateway: gatewayName } });
        }
      }
    }
    return { checked, settledLate };
  }

  /**
   * ArifPay has no transaction list. Each local session is verified, and a success notify whose
   * nonce has no payment row is verified too. The notify body never settles the invoice.
   */
  private async compareBySession(
    gateway: { name: string; verifySession?: (sessionId: string, txRef: string) => Promise<VerifiedTransaction> },
    openIssue: (data: { schoolId?: string | null; kind: string; txRef?: string | null; gatewayReference?: string | null; details: Prisma.InputJsonObject }) => Promise<void>,
  ): Promise<{ checked: number; settledLate: number }> {
    if (!gateway.verifySession) return { checked: 0, settledLate: 0 };
    const since = Date.now() - GATEWAY_WINDOW_MS;
    const settledBefore = new Date(Date.now() - HOUR);
    const local = await this.prisma.db.payment.findMany({
      where: {
        gateway: gateway.name,
        gatewaySessionId: { not: null },
        OR: [
          { status: 'SUCCEEDED', succeededAt: { gte: new Date(since + HOUR), lt: settledBefore } },
          { status: { in: ['PENDING', 'FAILED'] }, createdAt: { gte: new Date(since), lt: settledBefore } },
        ],
      },
    });

    let checked = 0;
    let settledLate = 0;
    const seenTx = new Set<string>();
    for (const payment of local) {
      if (!payment.gatewaySessionId) continue;
      seenTx.add(payment.txRef);
      checked += 1;
      let verified: VerifiedTransaction;
      try {
        verified = await gateway.verifySession(payment.gatewaySessionId, payment.txRef);
      } catch (error) {
        this.logger.warn(`Could not verify ${gateway.name} session for ${payment.txRef}: ${(error as Error).message}`);
        continue;
      }
      let current = payment;
      if ((payment.status === 'PENDING' || payment.status === 'FAILED') && verified.status === 'succeeded') {
        const outcome = await this.payments.verifyAndSettle(payment.txRef, 'sweep').catch(() => 'error' as const);
        if (outcome === 'succeeded') settledLate += 1;
        current = await this.prisma.db.payment.findUniqueOrThrow({ where: { txRef: payment.txRef } });
      }
      if (current.status === 'SUCCEEDED' || current.status === 'REFUNDED' || current.status === 'REVERSED') {
        if (verified.status !== 'succeeded' && verified.status !== 'refunded' && verified.status !== 'reversed') {
          await openIssue({
            schoolId: current.schoolId,
            kind: 'missing_at_gateway',
            txRef: current.txRef,
            gatewayReference: current.gatewayReference,
            details: { amount: current.amount, gateway: gateway.name, verifiedStatus: verified.status },
          });
        } else if (current.amount !== verified.amount || current.currency !== verified.currency) {
          await openIssue({
            schoolId: current.schoolId,
            kind: 'amount_mismatch',
            txRef: current.txRef,
            gatewayReference: verified.gatewayReference ?? current.gatewayReference,
            details: { gatewayAmount: verified.amount, localAmount: current.amount, gatewayCurrency: verified.currency },
          });
        }
      } else if (verified.status === 'succeeded') {
        await openIssue({
          schoolId: current.schoolId,
          kind: 'status_mismatch',
          txRef: current.txRef,
          gatewayReference: verified.gatewayReference,
          details: { gatewayStatus: verified.status, localStatus: current.status, amount: verified.amount },
        });
      }
    }

    const notifies = await this.prisma.db.webhookEvent.findMany({
      where: { gateway: gateway.name, signatureValid: true, txRef: { not: null }, receivedAt: { gte: new Date(since) } },
    });
    for (const event of notifies) {
      if (!event.txRef || seenTx.has(event.txRef) || !gatewayPayloadClaimsSuccess(event.payload)) continue;
      const payment = await this.prisma.db.payment.findUnique({ where: { txRef: event.txRef } });
      if (payment) continue;
      seenTx.add(event.txRef);
      if (!event.sessionId) continue;
      checked += 1;
      try {
        const verified = await gateway.verifySession(event.sessionId, event.txRef);
        if (verified.status !== 'succeeded') continue;
        await openIssue({
          kind: 'gateway_tx_unknown',
          txRef: event.txRef,
          gatewayReference: verified.gatewayReference,
          details: { gateway: gateway.name, amount: verified.amount, currency: verified.currency, sessionId: event.sessionId },
        });
      } catch (error) {
        this.logger.warn(`Could not verify ${gateway.name} notify ${event.txRef}: ${(error as Error).message}`);
      }
    }
    return { checked, settledLate };
  }

  async cleanup(): Promise<{ idempotencyKeys: number; otps: number; refreshTokens: number }> {
    const now = new Date();
    const idempotencyKeys = await this.prisma.db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
    const otps = await this.prisma.db.parentOtp.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DAY) } } });
    const refreshTokens = await this.prisma.db.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 30 * DAY) } }, { revokedAt: { lt: new Date(now.getTime() - 30 * DAY) } }] },
    });
    return { idempotencyKeys: idempotencyKeys.count, otps: otps.count, refreshTokens: refreshTokens.count };
  }

  runs(limit: number) {
    return this.prisma.db.reconciliationRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  }

  issues(filter: { schoolId?: string; status?: IssueStatus; kind?: string; page: number; pageSize: number }) {
    const where: Prisma.ReconciliationIssueWhereInput = {};
    if (filter.schoolId) where.schoolId = filter.schoolId;
    if (filter.status) where.status = filter.status;
    if (filter.kind) where.kind = filter.kind;
    const load = async (tx: Tx | PrismaService['db']) => {
      const items = await tx.reconciliationIssue.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize });
      const total = await tx.reconciliationIssue.count({ where });
      return { items, total, page: filter.page, pageSize: filter.pageSize };
    };
    return filter.schoolId ? this.prisma.tenant(filter.schoolId, load) : load(this.prisma.db);
  }

  async resolve(issueId: string, note: string, principal: Principal, schoolId?: string) {
    const apply = async (tx: Tx | PrismaService['db']) => {
      const issue = await tx.reconciliationIssue.findFirst({ where: { id: issueId, ...(schoolId ? { schoolId } : {}) } });
      if (!issue) throw new NotFoundException('Issue not found');
      const updated = await tx.reconciliationIssue.update({
        where: { id: issueId },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: principal.type === 'user' ? principal.userId : null, resolutionNote: note },
      });
      await this.audit.record({ schoolId: issue.schoolId, principal, action: 'reconciliation_issue.resolved', entityType: 'ReconciliationIssue', entityId: issueId, metadata: { note, kind: issue.kind } }, tx);
      return updated;
    };
    return schoolId ? this.prisma.tenant(schoolId, apply) : apply(this.prisma.db);
  }

  async exportIssuesToCsv(filter: { schoolId?: string; status?: IssueStatus; kind?: string }): Promise<string> {
    const where: Prisma.ReconciliationIssueWhereInput = {};
    if (filter.schoolId) where.schoolId = filter.schoolId;
    if (filter.status) where.status = filter.status;
    if (filter.kind) where.kind = filter.kind;

    const load = async (tx: Tx | PrismaService['db']) => {
      const issues = await tx.reconciliationIssue.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      const schoolIds = [
        ...new Set(issues.map((issue) => issue.schoolId).filter((id): id is string => id !== null)),
      ];
      const schools = schoolIds.length
        ? await tx.school.findMany({
            where: { id: { in: schoolIds } },
            select: { id: true, name: true, code: true },
          })
        : [];
      const schoolById = new Map(schools.map((school) => [school.id, school]));

      // CSV header
      const headers = [
        'ID',
        'School',
        'School Code',
        'Issue Type',
        'Status',
        'Merchant Reference',
        'Gateway Reference',
        'Created At',
        'Resolved At',
        'Resolution Note',
        'Details',
      ];

      // CSV rows
      const rows = issues.map((issue) => {
        const details = issue.details ? JSON.stringify(issue.details) : '';
        const school = issue.schoolId ? schoolById.get(issue.schoolId) : undefined;
        return [
          issue.id,
          school?.name || 'N/A',
          school?.code || 'N/A',
          issue.kind,
          issue.status,
          issue.txRef || '',
          issue.gatewayReference || '',
          issue.createdAt.toISOString(),
          issue.resolvedAt?.toISOString() || '',
          this.escapeCsvValue(issue.resolutionNote || ''),
          this.escapeCsvValue(details),
        ].join(',');
      });

      return [headers.join(','), ...rows].join('\n');
    };

    return filter.schoolId ? this.prisma.tenant(filter.schoolId, load) : load(this.prisma.db);
  }

  private escapeCsvValue(value: string): string {
    // Escape double quotes and wrap in quotes if contains comma, newline, or quote
    if (value.includes(',') || value.includes('\n') || value.includes('"')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
