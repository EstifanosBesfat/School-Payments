import { Prisma } from '@payment/db';
import { AuditService } from '../audit/audit.service';
import { SecretBox } from '../common/crypto.util';
import type { AppEnv } from '../config/config.module';
import { GatewayError, type DirectPayRequest, type DirectPayResult, type VerifiedTransaction } from '../gateways/payment-gateway.interface';
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
  gatewaySessionId: string | null;
  sessionExpiresAt: Date | null;
  payerMethod: string | null;
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
  school: {
    id: string;
    status: string;
    code: string;
    name: string;
    contactEmail: string;
    chapaSubaccountId: string | null;
    payoutBankCode: string | null;
    payoutAccountEncrypted: string | null;
  };
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

function harness(gatewayName: 'chapa' | 'arifpay' = 'chapa') {
  const payments: StoredPayment[] = [];
  const invoices: StoredInvoice[] = [];
  const audits: { action: string; entityId?: string | null }[] = [];
  const ledgerPosts: unknown[][] = [];
  const jobs: { queue: string; name: string; data: unknown; jobId?: string }[] = [];
  const tenantIds: string[] = [];
  const secrets = new SecretBox(Buffer.alloc(32, 3).toString('base64'));
  const payoutAccountNumber = '1000123456789';
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
    school: {
      id: 'school_1',
      status: 'ACTIVE',
      code: 'DEMO',
      name: 'Demo School',
      contactEmail: 'fees@demo.school',
      chapaSubaccountId: 'sub_1',
      payoutBankCode: 'AWINETAA',
      payoutAccountEncrypted: secrets.encrypt(payoutAccountNumber),
    },
    student: { firstName: 'Sara', lastName: 'Bekele' },
    lines: [{ description: 'Tuition', amount: AMOUNT, position: 0 }],
  };
  const invoiceB: StoredInvoice = { ...invoiceA, id: 'inv_b', payToken: 'pay-token-b', number: 'INV-2', paidAmount: 0, status: 'ISSUED' };
  invoices.push(invoiceA, invoiceB);

  function findPayment(where: { id?: string; txRef?: string; gatewayReference?: string }): StoredPayment | undefined {
    return payments.find(
      (payment) =>
        (where.id ? payment.id === where.id : true) &&
        (where.txRef ? payment.txRef === where.txRef : true) &&
        (where.gatewayReference ? payment.gatewayReference === where.gatewayReference : true),
    );
  }

  const tx = {
    $queryRaw: async () => [],
    payment: {
      findUnique: async ({ where }: { where: { id?: string; txRef?: string; gatewayReference?: string } }) => findPayment(where) ?? null,
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
        const status = data.status ?? 'PENDING';
        const invoiceId = data.invoiceId ?? invoiceA.id;
        if (status === 'PENDING' && payments.some((payment) => payment.invoiceId === invoiceId && payment.status === 'PENDING')) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on payment_one_pending_per_invoice', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: 'payment_one_pending_per_invoice' },
          });
        }
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
          gatewaySessionId: null,
          sessionExpiresAt: null,
          payerMethod: null,
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
      findFirst: async ({ where }: { where: { id?: string; schoolId?: string } }) =>
        invoices.find((invoice) => (where.id ? invoice.id === where.id : true) && (where.schoolId ? invoice.schoolId === where.schoolId : true)) ?? null,
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
    tenant: async (schoolId: string, fn: (client: typeof tx) => Promise<unknown>) => {
      tenantIds.push(schoolId);
      const run = tail.then(() => fn(tx));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  const verify = jest.fn<Promise<VerifiedTransaction>, [string]>();
  const verifySession = jest.fn(async (_sessionId: string, txRef: string) => verify(txRef));
  const initialize = jest.fn(async (request: { txRef: string }) => ({ checkoutUrl: `https://checkout.test/${request.txRef}` }));
  const directPay = jest.fn(async (request: DirectPayRequest): Promise<DirectPayResult> => ({
    sessionId: `sess-${request.txRef}`,
    expiresAt: request.expiresAt.toISOString(),
    alreadySucceeded: false,
    alreadyFailed: false,
  }));
  const gateway =
    gatewayName === 'arifpay'
      ? { name: gatewayName, verify, verifySession, initialize, directPay }
      : { name: gatewayName, verify, initialize };
  const queues = {
    add: jest.fn(async (queue: string, name: string, data: unknown, options?: { jobId?: string }) => {
      jobs.push({ queue, name, data, jobId: options?.jobId });
    }),
    register: jest.fn(),
  };
  const outbound = { emit: jest.fn(async () => undefined) };
  const service = new PaymentsService(
    {
      PLATFORM_FEE_VALUE: 0,
      PLATFORM_FEE_TYPE: 'percentage',
      API_PUBLIC_URL: 'http://localhost:4000',
      WEB_URL: 'http://localhost:3000',
      ARIFPAY_FALLBACK_EMAIL: 'fees@demo.school',
    } as AppEnv,
    prisma as never,
    { get: () => gateway, default: () => gateway } as never,
    new LedgerService(prisma as never),
    new AuditService(prisma as never),
    queues as never,
    outbound as never,
    secrets,
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
      gatewaySessionId: null,
      sessionExpiresAt: null,
      payerMethod: null,
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

  return {
    service,
    payments,
    invoices,
    invoiceA,
    invoiceB,
    audits,
    ledgerPosts,
    jobs,
    verify,
    verifySession,
    initialize,
    directPay,
    outbound,
    tenantIds,
    payoutAccountNumber,
    seedPayment,
  };
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
    const payer = { payerName: 'Abebe Bekele', payerPhone: '+251911223344', method: 'telebirr' as const };
    const first = await service.start(invoiceA.payToken, payer);
    expect(first).toMatchObject({ kind: 'redirect' });
    if (first.kind !== 'redirect') throw new Error('expected a hosted checkout redirect');
    expect(first.checkoutUrl).toContain(first.txRef);
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

describe('ArifPay phone prompt start', () => {
  const payer = { payerName: 'Abebe Bekele', payerPhone: '+251911223344', payerEmail: 'abebe@example.com', method: 'telebirr' as const };
  const cbePayer = { ...payer, payerPhone: '+251711223344', method: 'cbe_birr' as const };

  it('returns a phone prompt and reuses the same attempt before the session expires', async () => {
    const { service, payments, invoiceA, directPay, initialize, tenantIds, payoutAccountNumber } = harness('arifpay');
    const first = await service.start(invoiceA.payToken, payer, '127.0.0.1');
    expect(first.kind).toBe('phone_prompt');
    if (first.kind !== 'phone_prompt') throw new Error('expected a phone prompt');
    expect(first.method).toBe('telebirr');
    expect(first.txRef.startsWith('DEMO-')).toBe(true);
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(initialize).not.toHaveBeenCalled();
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      schoolId: invoiceA.schoolId,
      invoiceId: invoiceA.id,
      status: 'PENDING',
      amount: AMOUNT,
      payerMethod: 'telebirr',
      gateway: 'arifpay',
      gatewaySessionId: `sess-${first.txRef}`,
    });
    expect(directPay).toHaveBeenCalledTimes(1);
    expect(directPay).toHaveBeenCalledWith(
      expect.objectContaining({
        txRef: first.txRef,
        amount: AMOUNT,
        currency: 'ETB',
        method: 'telebirr',
        phone: '+251911223344',
        email: 'abebe@example.com',
        notifyUrl: 'http://localhost:4000/webhooks/arifpay',
        returnUrl: `http://localhost:3000/pay/${invoiceA.payToken}/return?tx=${encodeURIComponent(first.txRef)}`,
        beneficiary: { accountNumber: payoutAccountNumber, bank: 'AWINETAA', amount: AMOUNT },
      }),
    );
    expect(tenantIds).toContain(invoiceA.schoolId);
    expect(invoiceA.status).toBe('ISSUED');
    expect(invoiceA.paidAmount).toBe(0);

    const second = await service.start(invoiceA.payToken, { ...payer, payerPhone: '+251922334455' });
    expect(second).toMatchObject({ kind: 'phone_prompt', txRef: first.txRef, method: 'telebirr' });
    expect(payments).toHaveLength(1);
    expect(directPay).toHaveBeenCalledTimes(2);
    const replay = directPay.mock.calls[1]?.[0];
    expect(replay?.txRef).toBe(first.txRef);
    expect(replay?.method).toBe('telebirr');
  });

  it('verifies a pending Telebirr attempt before switching to CBE Birr', async () => {
    const { service, payments, invoiceA, verify, directPay } = harness('arifpay');
    const first = await service.start(invoiceA.payToken, payer);
    verify.mockResolvedValueOnce(verified({ status: 'pending', txRef: first.txRef, amount: 0, gatewayReference: null }));

    const second = await service.start(invoiceA.payToken, cbePayer);
    expect(verify).toHaveBeenCalledWith(first.txRef);
    expect(second.kind).toBe('phone_prompt');
    if (second.kind !== 'phone_prompt') throw new Error('expected a phone prompt');
    expect(second.txRef).not.toBe(first.txRef);
    expect(second.method).toBe('cbe_birr');
    expect(payments.find((payment) => payment.txRef === first.txRef)).toMatchObject({
      status: 'FAILED',
      failureReason: 'superseded_by_method_change',
    });
    expect(payments.filter((payment) => payment.status === 'PENDING')).toHaveLength(1);
    expect(payments.find((payment) => payment.txRef === second.txRef)?.payerMethod).toBe('cbe_birr');
    expect(directPay).toHaveBeenCalledTimes(2);
    expect(invoiceA.status).toBe('ISSUED');
    expect(invoiceA.paidAmount).toBe(0);
  });

  it('settles a verified Telebirr success instead of opening a CBE Birr attempt', async () => {
    const { service, payments, invoiceA, invoiceB, verify, directPay } = harness('arifpay');
    const first = await service.start(invoiceA.payToken, payer);
    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: first.txRef }));

    const second = await service.start(invoiceA.payToken, cbePayer);
    expect(second).toMatchObject({ kind: 'phone_prompt', txRef: first.txRef, method: 'telebirr' });
    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe('SUCCEEDED');
    expect(directPay).toHaveBeenCalledTimes(1);
    expect(invoiceA.status).toBe('PAID');
    expect(invoiceA.paidAmount).toBe(AMOUNT);
    expect(invoiceB.status).toBe('ISSUED');
    expect(invoiceB.paidAmount).toBe(0);
  });

  it('returns the single pending row when two starts race', async () => {
    const { service, payments, invoiceA, directPay } = harness('arifpay');
    directPay.mockImplementation(async (request: DirectPayRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        sessionId: `sess-${request.txRef}`,
        expiresAt: request.expiresAt.toISOString(),
        alreadySucceeded: false,
        alreadyFailed: false,
      };
    });

    const [first, second] = await Promise.all([service.start(invoiceA.payToken, payer), service.start(invoiceA.payToken, payer)]);
    expect(first).toMatchObject({ kind: 'phone_prompt', txRef: second.kind === 'phone_prompt' ? second.txRef : first.txRef });
    if (first.kind !== 'phone_prompt' || second.kind !== 'phone_prompt') throw new Error('expected phone prompts');
    expect(second.txRef).toBe(first.txRef);
    expect(payments.filter((payment) => payment.status === 'PENDING')).toHaveLength(1);
    expect(payments).toHaveLength(1);
    expect(directPay.mock.calls.every((call) => call[0].txRef === first.txRef)).toBe(true);
  });

  it('verifies an expired prompt and mints a new nonce only when it is unpaid', async () => {
    const { service, payments, invoiceA, verify, directPay } = harness('arifpay');
    const first = await service.start(invoiceA.payToken, payer);
    const row = payments.find((payment) => payment.txRef === first.txRef);
    if (!row?.sessionExpiresAt) throw new Error('expected a session expiry');
    row.sessionExpiresAt = new Date(Date.now() - 1000);
    verify.mockResolvedValueOnce(verified({ status: 'pending', txRef: first.txRef, amount: 0, gatewayReference: null }));

    const second = await service.start(invoiceA.payToken, payer);
    expect(verify).toHaveBeenCalledWith(first.txRef);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('expired');
    expect(second.kind).toBe('phone_prompt');
    if (second.kind !== 'phone_prompt') throw new Error('expected a phone prompt');
    expect(second.txRef).not.toBe(first.txRef);
    expect(payments.filter((payment) => payment.status === 'PENDING')).toHaveLength(1);
    expect(directPay.mock.calls[1]?.[0].txRef).toBe(second.txRef);
    expect(invoiceA.paidAmount).toBe(0);
  });

  it('does not mint a new nonce when the expired prompt verifies as paid', async () => {
    const { service, payments, invoiceA, verify, directPay } = harness('arifpay');
    const first = await service.start(invoiceA.payToken, payer);
    const row = payments.find((payment) => payment.txRef === first.txRef);
    if (!row) throw new Error('missing attempt');
    row.sessionExpiresAt = new Date(Date.now() - 1000);
    verify.mockResolvedValueOnce(verified({ status: 'succeeded', txRef: first.txRef }));

    const second = await service.start(invoiceA.payToken, payer);
    expect(second).toMatchObject({ kind: 'phone_prompt', txRef: first.txRef });
    expect(payments).toHaveLength(1);
    expect(row.status).toBe('SUCCEEDED');
    expect(directPay).toHaveBeenCalledTimes(1);
    expect(invoiceA.status).toBe('PAID');
    expect(invoiceA.paidAmount).toBe(AMOUNT);
  });

  it('marks a prompt FAILED when directPay fails before a session id exists, without naming a provider', async () => {
    const { service, payments, invoiceA, ledgerPosts, directPay } = harness('arifpay');
    directPay.mockRejectedValueOnce(new GatewayError('ArifPay POST /api/checkout/telebirr-ussd/transfer/direct failed (500): internal system error', true));

    let thrown: unknown;
    try {
      await service.start(invoiceA.payToken, payer);
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toMatch(/could not send the request to your phone/i);
    expect(message.toLowerCase()).not.toContain('arifpay');
    expect(message.toLowerCase()).not.toContain('chapa');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'FAILED', failureReason: 'initialize_failed', gatewaySessionId: null });
    expect(payments.filter((payment) => payment.txRef === payments[0]?.txRef)).toHaveLength(1);
    expect(invoiceA.status).toBe('ISSUED');
    expect(invoiceA.paidAmount).toBe(0);
    expect(ledgerPosts).toHaveLength(0);
  });

  it('keeps the attempt pending when a later directPay fails after the session id was saved', async () => {
    const { service, payments, invoiceA, directPay } = harness('arifpay');
    const first = await service.start(invoiceA.payToken, payer);
    const sessionId = payments[0]?.gatewaySessionId;
    expect(sessionId).toBe(`sess-${first.txRef}`);
    directPay.mockRejectedValueOnce(new GatewayError('ArifPay POST failed (500): internal system error', true));

    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/could not send the request to your phone/i);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'PENDING', gatewaySessionId: sessionId, txRef: first.txRef });
    expect(invoiceA.status).toBe('ISSUED');
    expect(invoiceA.paidAmount).toBe(0);

    const third = await service.start(invoiceA.payToken, payer);
    expect(third).toMatchObject({ kind: 'phone_prompt', txRef: first.txRef, method: 'telebirr' });
    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe('PENDING');
  });

  it('rejects unpaid invoices, inactive schools, and a school with no payout account', async () => {
    const { service, payments, invoiceA, directPay } = harness('arifpay');
    const encrypted = invoiceA.school.payoutAccountEncrypted;
    const bank = invoiceA.school.payoutBankCode;

    invoiceA.status = 'PAID';
    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/paid/);
    invoiceA.status = 'CANCELLED';
    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/cancelled/);
    invoiceA.status = 'PARTIALLY_PAID';
    invoiceA.paidAmount = invoiceA.totalAmount;
    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/Nothing left to pay/);

    invoiceA.status = 'ISSUED';
    invoiceA.paidAmount = 0;
    invoiceA.school.status = 'SUSPENDED';
    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/not accepting online payments/);

    invoiceA.school.status = 'ACTIVE';
    invoiceA.school.payoutAccountEncrypted = null;
    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/payout setup/);
    invoiceA.school.payoutAccountEncrypted = encrypted;
    invoiceA.school.payoutBankCode = null;
    await expect(service.start(invoiceA.payToken, payer)).rejects.toThrow(/payout setup/);
    invoiceA.school.payoutBankCode = bank;

    expect(directPay).not.toHaveBeenCalled();
    expect(payments).toHaveLength(0);
    expect(invoiceA.paidAmount).toBe(0);
    expect(invoiceA.status).toBe('ISSUED');
  });

  it('charges the remaining balance and takes schoolId from the invoice', async () => {
    const { service, payments, invoiceA, directPay, tenantIds, payoutAccountNumber } = harness('arifpay');
    invoiceA.status = 'PARTIALLY_PAID';
    invoiceA.paidAmount = 50_000;
    invoiceA.schoolId = 'school_9';
    invoiceA.school.id = 'school_9';

    const started = await service.start(invoiceA.payToken, payer);
    expect(started.kind).toBe('phone_prompt');
    expect(payments[0]).toMatchObject({ schoolId: 'school_9', amount: 100_000, status: 'PENDING' });
    expect(directPay).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100_000,
        beneficiary: { accountNumber: payoutAccountNumber, bank: 'AWINETAA', amount: 100_000 },
      }),
    );
    expect(tenantIds).toContain('school_9');
    expect(invoiceA.paidAmount).toBe(50_000);
    expect(invoiceA.status).toBe('PARTIALLY_PAID');
  });
});
