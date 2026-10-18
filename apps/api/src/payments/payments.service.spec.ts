import { AuditService } from '../audit/audit.service';
import type { AppEnv } from '../config/config.module';
import { GatewayError, type VerifiedTransaction } from '../gateways/payment-gateway.interface';
import { LedgerService } from '../ledger/ledger.service';
import { JOBS, QUEUES } from '../queue/queue.constants';
import { PaymentsService } from './payments.service';

const AMOUNT = 150_000;

interface StoredPayment {
  id: string;
  schoolId: string;
  invoiceId: string;
  txRef: string;
  gateway: string;
  status: string;
  amount: number;
  currency: string;
  payerName: string;
  payerPhone: string;
  payerEmail: string | null;
  checkoutUrl: string | null;
  gatewayReference: string | null;
  method: string | null;
  gatewayFee: number | null;
  platformFee: number | null;
  rawVerifyResponse: unknown;
  failureReason: string | null;
  reviewReason: string | null;
  verifiedAt: Date | null;
  succeededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredInvoice {
  id: string;
  schoolId: string;
  payToken: string;
  number: string;
  status: string;
  currency: string;
  totalAmount: number;
  paidAmount: number;
  paidAt: Date | null;
  term: string | null;
  dueDate: Date;
  school: { id: string; status: string; code: string; name: string; chapaSubaccountId: string | null };
  student: { firstName: string; lastName: string };
  lines: { description: string; amount: number; position: number }[];
}

function verified(overrides: Partial<VerifiedTransaction> & Pick<VerifiedTransaction, 'status'>): VerifiedTransaction {
  return {
    txRef: 'DEMO-TX1',
    amount: AMOUNT,
    currency: 'ETB',
    gatewayReference: overrides.status === 'succeeded' ? 'AP123' : null,
    method: 'card',
    fee: null,
    mode: 'test',
    raw: { status: overrides.status },
    ...overrides,
  };
}

function harness() {
  const payments: StoredPayment[] = [];
  const invoices: StoredInvoice[] = [];
  const audits: { action: string; entityId?: string | null }[] = [];
  const ledgerPosts: unknown[][] = [];
  const jobs: { queue: string; name: string; data: unknown; jobId?: string }[] = [];
  let paymentSeq = 0;
  let tail = Promise.resolve();

  const invoiceA: StoredInvoice = {
    id: 'inv_a',
    schoolId: 'school_1',
    payToken: 'pay-token-a',
    number: 'INV-1',
    status: 'ISSUED',
    currency: 'ETB',
    totalAmount: AMOUNT,
    paidAmount: 0,
    paidAt: null,
    term: '1',
    dueDate: new Date('2026-11-01'),
    school: { id: 'school_1', status: 'ACTIVE', code: 'DEMO', name: 'Demo School', chapaSubaccountId: 'sub_1' },
    student: { firstName: 'Sara', lastName: 'Bekele' },
    lines: [{ description: 'Tuition', amount: AMOUNT, position: 0 }],
  };
  const invoiceB: StoredInvoice = { ...invoiceA, id: 'inv_b', payToken: 'pay-token-b', number: 'INV-2', paidAmount: 0, status: 'ISSUED' };
  invoices.push(invoiceA, invoiceB);

  function findPayment(where: { id?: string; txRef?: string }): StoredPayment | undefined {
    return payments.find((payment) => (where.id ? payment.id === where.id : true) && (where.txRef ? payment.txRef === where.txRef : true));
  }

  const tx = {
    $queryRaw: async () => [],
    payment: {
      findUnique: async ({ where }: { where: { id?: string; txRef?: string } }) => findPayment(where) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id?: string; txRef?: string } }) => {
        const payment = findPayment(where);
        if (!payment) throw new Error('payment missing');
        return payment;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const matches = payments.filter((payment) => {
          if (where.invoiceId && payment.invoiceId !== where.invoiceId) return false;
          if (where.status && payment.status !== where.status) return false;
          if (where.amount !== undefined && payment.amount !== where.amount) return false;
          if (where.payerPhone && payment.payerPhone !== where.payerPhone) return false;
          if (where.gateway && payment.gateway !== where.gateway) return false;
          const checkout = where.checkoutUrl as { not?: null } | undefined;
          if (checkout && 'not' in checkout && checkout.not === null && payment.checkoutUrl == null) return false;
          const createdAt = where.createdAt as { gt?: Date } | undefined;
          if (createdAt?.gt && !(payment.createdAt > createdAt.gt)) return false;
          return true;
        });
        return matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
      },
      create: async ({ data }: { data: Partial<StoredPayment> }) => {
        paymentSeq += 1;
        const payment: StoredPayment = {
          id: `pay_${paymentSeq}`,
          schoolId: 'school_1',
          invoiceId: invoiceA.id,
          txRef: `DEMO-TX${paymentSeq}`,
          gateway: 'chapa',
          status: 'PENDING',
          amount: AMOUNT,
          currency: 'ETB',
          payerName: 'Abebe Bekele',
          payerPhone: '+251911223344',
          payerEmail: null,
          checkoutUrl: null,
          gatewayReference: null,
          method: null,
          gatewayFee: null,
          platformFee: null,
          rawVerifyResponse: null,
          failureReason: null,
          reviewReason: null,
          verifiedAt: null,
          succeededAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        payments.push(payment);
        return payment;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredPayment> }) => {
        const payment = findPayment(where);
        if (!payment) throw new Error('payment missing');
        Object.assign(payment, data, { updatedAt: new Date() });
        return payment;
      },
      updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Partial<StoredPayment> }) => {
        const payment = findPayment({ id: where.id });
        if (!payment || (where.status && payment.status !== where.status)) return { count: 0 };
        Object.assign(payment, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    invoice: {
      findUnique: async ({ where }: { where: { id?: string; payToken?: string } }) =>
        invoices.find((invoice) => (where.id ? invoice.id === where.id : invoice.payToken === where.payToken)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const invoice = invoices.find((item) => item.id === where.id);
        if (!invoice) throw new Error('invoice missing');
        return invoice;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredInvoice> }) => {
        const invoice = invoices.find((item) => item.id === where.id);
        if (!invoice) throw new Error('invoice missing');
        Object.assign(invoice, data);
        return invoice;
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string; entityId?: string | null } }) => {
        audits.push(data);
        return data;
      },
    },
    reconciliationIssue: { create: async ({ data }: { data: unknown }) => data },
    ledgerEntry: {
      createMany: async ({ data }: { data: unknown[] }) => {
        ledgerPosts.push(data);
        return { count: data.length };
      },
    },
  };

  const prisma = {
    db: tx,
    tenant: async (_schoolId: string, fn: (client: typeof tx) => Promise<unknown>) => {
      const run = tail.then(() => fn(tx));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  const verify = jest.fn<Promise<VerifiedTransaction>, [string]>();
  const initialize = jest.fn(async (request: { txRef: string }) => ({ checkoutUrl: `https://checkout.test/${request.txRef}` }));
  const gateway = { name: 'chapa', verify, initialize };
  const queues = {
    add: jest.fn(async (queue: string, name: string, data: unknown, options?: { jobId?: string }) => {
      jobs.push({ queue, name, data, jobId: options?.jobId });
    }),
    register: jest.fn(),
  };
  const outbound = { emit: jest.fn(async () => undefined) };
  const service = new PaymentsService(
    { PLATFORM_FEE_VALUE: 0, PLATFORM_FEE_TYPE: 'percentage', API_PUBLIC_URL: 'http://localhost:4000', WEB_URL: 'http://localhost:3000' } as AppEnv,
    prisma as never,
    { get: () => gateway, default: () => gateway } as never,
    new LedgerService(prisma as never),
    new AuditService(prisma as never),
    queues as never,
    outbound as never,
  );

  function seedPayment(overrides: Partial<StoredPayment> = {}): StoredPayment {
    paymentSeq += 1;
    const payment: StoredPayment = {
      id: overrides.id ?? `pay_${paymentSeq}`,
      schoolId: 'school_1',
      invoiceId: invoiceA.id,
      txRef: overrides.txRef ?? 'DEMO-TX1',
      gateway: 'chapa',
      status: 'PENDING',
      amount: AMOUNT,
      currency: 'ETB',
      payerName: 'Abebe Bekele',
      payerPhone: '+251911223344',
      payerEmail: null,
      checkoutUrl: 'https://checkout.test/DEMO-TX1',
      gatewayReference: null,
      method: null,
      gatewayFee: null,
      platformFee: null,
      rawVerifyResponse: null,
      failureReason: null,
      reviewReason: null,
      verifiedAt: null,
      succeededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    payments.push(payment);
    return payment;
  }

  return { service, payments, invoices, invoiceA, invoiceB, audits, ledgerPosts, jobs, verify, initialize, outbound, seedPayment };
}

describe('Chapa card retry settlement', () => {
  it('settles a later verified success for the same tx_ref after the first card attempt failed', async () => {
    const { service, invoiceA, invoiceB, audits, ledgerPosts, jobs, verify, outbound, seedPayment } = harness();
    const payment = seedPayment();
    verify.mockResolvedValueOnce(verified({ status: 'failed' }));

    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('failed');
    expect(payment.status).toBe('FAILED');
    expect(payment.failureReason).toBe('gateway_reported_failed');
    expect(invoiceA.status).toBe('ISSUED');
    expect(invoiceA.paidAmount).toBe(0);
    expect(jobs.filter((job) => job.jobId?.startsWith('card-retry-'))).toHaveLength(3);

    verify.mockResolvedValueOnce(verified({ status: 'succeeded' }));
    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('succeeded');
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.failureReason).toBeNull();
    expect(payment.gatewayReference).toBe('AP123');
    expect(invoiceA.status).toBe('PAID');
    expect(invoiceA.paidAmount).toBe(AMOUNT);
    expect(invoiceB.paidAmount).toBe(0);
    expect(invoiceB.status).toBe('ISSUED');
    expect(ledgerPosts).toHaveLength(1);
    expect(jobs.filter((job) => job.name === JOBS.issueReceipt && job.queue === QUEUES.receipts)).toEqual([
      expect.objectContaining({ jobId: `receipt-${payment.id}` }),
    ]);
    expect(audits.map((entry) => entry.action)).toEqual(['payment.failed', 'payment.succeeded']);
    expect(outbound.emit).toHaveBeenCalledTimes(2);

    verify.mockResolvedValueOnce(verified({ status: 'succeeded' }));
    await expect(service.verifyAndSettle(payment.txRef, 'manual')).resolves.toBe('already_final');
    expect(ledgerPosts).toHaveLength(1);
    expect(jobs.filter((job) => job.name === JOBS.issueReceipt)).toHaveLength(1);
    expect(invoiceA.paidAmount).toBe(AMOUNT);
  });

  it('starts a new tx_ref after a failed attempt and settles that attempt on its own', async () => {
    const { service, payments, invoiceA, verify, initialize } = harness();
    const payer = { payerName: 'Abebe Bekele', payerPhone: '+251911223344' };
    const first = await service.start(invoiceA.payToken, payer);
    verify.mockResolvedValueOnce(verified({ status: 'failed', txRef: first.txRef }));
    await expect(service.verifyAndSettle(first.txRef, 'callback')).resolves.toBe('failed');

    const second = await service.start(invoiceA.payToken, payer);
    expect(second.txRef).not.toBe(first.txRef);
    expect(payments.map((payment) => payment.txRef)).toEqual([first.txRef, second.txRef]);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(invoiceA.status).toBe('ISSUED');

    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: second.txRef }));
    await expect(service.verifyAndSettle(second.txRef, 'webhook')).resolves.toBe('succeeded');
    expect(payments.find((payment) => payment.txRef === first.txRef)?.status).toBe('FAILED');
    expect(payments.find((payment) => payment.txRef === second.txRef)?.status).toBe('SUCCEEDED');
    expect(invoiceA.status).toBe('PAID');
    expect(invoiceA.paidAmount).toBe(AMOUNT);
  });

  it('does not repeat side effects for a duplicate failure observation', async () => {
    const { service, invoiceA, audits, jobs, verify, outbound, seedPayment } = harness();
    const payment = seedPayment();
    verify.mockResolvedValue(verified({ status: 'failed' }));
    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('failed');
    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('already_failed');
    expect(audits.filter((entry) => entry.action === 'payment.failed')).toHaveLength(1);
    expect(outbound.emit).toHaveBeenCalledTimes(1);
    expect(new Set(jobs.filter((job) => job.jobId?.startsWith('card-retry-')).map((job) => job.jobId)).size).toBe(3);
    expect(invoiceA.paidAmount).toBe(0);
    expect(payment.status).toBe('FAILED');
  });

  it('ignores a stale failure after the payment is already succeeded', async () => {
    const { service, invoiceA, ledgerPosts, jobs, verify, seedPayment } = harness();
    const payment = seedPayment();
    verify.mockResolvedValueOnce(verified({ status: 'succeeded' }));
    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('succeeded');
    verify.mockResolvedValueOnce(verified({ status: 'failed' }));
    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('already_final');
    expect(payment.status).toBe('SUCCEEDED');
    expect(invoiceA.status).toBe('PAID');
    expect(invoiceA.paidAmount).toBe(AMOUNT);
    expect(ledgerPosts).toHaveLength(1);
    expect(jobs.filter((job) => job.name === JOBS.issueReceipt)).toHaveLength(1);
  });

  it('does not pay the invoice when verification is pending, rejected, or unavailable', async () => {
    const { service, invoiceA, verify, seedPayment } = harness();
    const pending = seedPayment({ txRef: 'DEMO-PENDING' });
    verify.mockResolvedValueOnce(verified({ status: 'pending', txRef: pending.txRef, amount: 0, gatewayReference: null }));
    await expect(service.verifyAndSettle(pending.txRef, 'return')).resolves.toBe('still_pending');
    expect(pending.status).toBe('PENDING');

    const mismatched = seedPayment({ id: 'pay_mismatch', txRef: 'DEMO-MISMATCH' });
    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: 'OTHER-REF' }));
    await expect(service.verifyAndSettle(mismatched.txRef, 'webhook')).resolves.toBe('rejected');
    expect(mismatched.status).toBe('PENDING');

    const unreachable = seedPayment({ id: 'pay_down', txRef: 'DEMO-DOWN' });
    verify.mockRejectedValueOnce(new GatewayError('Chapa request failed: socket hang up', true));
    await expect(service.verifyAndSettle(unreachable.txRef, 'webhook')).rejects.toThrow('socket hang up');
    expect(unreachable.status).toBe('PENDING');

    const declined = seedPayment({ id: 'pay_4xx', txRef: 'DEMO-4XX' });
    verify.mockRejectedValueOnce(new GatewayError('Chapa GET failed (404): not found', false));
    await expect(service.verifyAndSettle(declined.txRef, 'webhook')).resolves.toBe('still_pending');
    expect(declined.status).toBe('PENDING');
    expect(invoiceA.status).toBe('ISSUED');
    expect(invoiceA.paidAmount).toBe(0);
  });

  it('rejects a verified success with the wrong amount, currency, or invoice', async () => {
    const { service, invoiceA, invoiceB, verify, seedPayment } = harness();
    const wrongAmount = seedPayment({ txRef: 'DEMO-AMOUNT' });
    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: wrongAmount.txRef, amount: AMOUNT - 1 }));
    await expect(service.verifyAndSettle(wrongAmount.txRef, 'manual')).resolves.toBe('review');
    expect(wrongAmount.status).toBe('REVIEW');

    const wrongCurrency = seedPayment({ id: 'pay_usd', txRef: 'DEMO-USD' });
    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: wrongCurrency.txRef, currency: 'USD' }));
    await expect(service.verifyAndSettle(wrongCurrency.txRef, 'manual')).resolves.toBe('review');
    expect(wrongCurrency.status).toBe('REVIEW');

    invoiceA.status = 'CANCELLED';
    const late = seedPayment({ id: 'pay_late', txRef: 'DEMO-LATE' });
    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: late.txRef }));
    await expect(service.verifyAndSettle(late.txRef, 'webhook')).resolves.toBe('review');
    expect(late.status).toBe('REVIEW');
    expect(invoiceA.paidAmount).toBe(0);
    expect(invoiceB.paidAmount).toBe(0);
    expect(invoiceA.status).toBe('CANCELLED');
  });

  it('issues one receipt when two success verifications run together', async () => {
    const { service, invoiceA, ledgerPosts, jobs, verify, seedPayment } = harness();
    const payment = seedPayment();
    verify.mockResolvedValue(verified({ status: 'succeeded' }));
    const [first, second] = await Promise.all([
      service.verifyAndSettle(payment.txRef, 'webhook'),
      service.verifyAndSettle(payment.txRef, 'callback'),
    ]);
    expect([first, second].sort()).toEqual(['already_final', 'succeeded']);
    expect(payment.status).toBe('SUCCEEDED');
    expect(invoiceA.paidAmount).toBe(AMOUNT);
    expect(ledgerPosts).toHaveLength(1);
    expect(jobs.filter((job) => job.name === JOBS.issueReceipt)).toHaveLength(1);
  });

  it('does not schedule a card recheck that would run after the checkout window', async () => {
    const { service, jobs, verify, seedPayment } = harness();
    const payment = seedPayment({ createdAt: new Date(Date.now() - 25 * 60 * 1000) });
    verify.mockResolvedValueOnce(verified({ status: 'failed' }));
    await expect(service.verifyAndSettle(payment.txRef, 'webhook')).resolves.toBe('failed');
    const delays = jobs
      .filter((job) => job.jobId?.startsWith('card-retry-'))
      .map((job) => job.jobId);
    expect(delays).toEqual([`card-retry-${payment.txRef}-45000`, `card-retry-${payment.txRef}-180000`]);
  });

  it('does not ask Chapa again when checkout initialization itself failed', async () => {
    const { service, verify, seedPayment } = harness();
    const payment = seedPayment({ status: 'FAILED', failureReason: 'initialize_failed: timeout' });
    await expect(service.verifyAndSettle(payment.txRef, 'manual')).resolves.toBe('already_final');
    expect(verify).not.toHaveBeenCalled();
    expect(payment.status).toBe('FAILED');
  });

  it('returns unknown_payment without creating a row for a foreign reference', async () => {
    const { service, payments, invoiceA, verify } = harness();
    await expect(service.verifyAndSettle('DEMO-MISSING', 'webhook')).resolves.toBe('unknown_payment');
    expect(verify).not.toHaveBeenCalled();
    expect(payments).toHaveLength(0);
    expect(invoiceA.paidAmount).toBe(0);
  });
});
