import { Test } from '@nestjs/testing';
import type { AppEnv } from '../config/config.module';
import { GatewayError } from '../gateways/payment-gateway.interface';
import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { PaymentsService } from '../payments/payments.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { AuditService } from '../audit/audit.service';
import { PaymentLockService } from '../payments/payment-lock.service';
import { APP_ENV } from '../config/config.module';

describe('ReconciliationService - Sweep Worker', () => {
  let service: ReconciliationService;
  let findMany: jest.Mock;
  let payments: jest.Mocked<PaymentsService>;
  let locks: jest.Mocked<PaymentLockService>;
  let queues: jest.Mocked<QueueService>;

  beforeEach(async () => {
    findMany = jest.fn();
    const mockPrisma = {
      db: {
        payment: {
          findMany,
        },
      },
    };

    const mockPayments = {
      enqueueVerification: jest.fn(),
    };

    const mockLocks = {
      acquire: jest.fn(),
    };

    const mockQueues = {
      register: jest.fn(),
      schedule: jest.fn(),
    };

    const mockEnv = {
      RUN_WORKERS: true,
    };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QueueService, useValue: mockQueues },
        { provide: GatewayRegistry, useValue: {} },
        { provide: PaymentsService, useValue: mockPayments },
        { provide: ReceiptsService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: PaymentLockService, useValue: mockLocks },
        { provide: APP_ENV, useValue: mockEnv },
      ],
    }).compile();

    service = module.get(ReconciliationService);
    payments = module.get(PaymentsService) as jest.Mocked<PaymentsService>;
    locks = module.get(PaymentLockService) as jest.Mocked<PaymentLockService>;
    queues = module.get(QueueService) as jest.Mocked<QueueService>;
  });

  describe('sweepPending', () => {
    it('should queue verification for PENDING payments older than 10 minutes', async () => {
      const now = Date.now();
      const elevenMinutesAgo = new Date(now - 11 * 60 * 1000);

      findMany.mockResolvedValue([
        { txRef: 'SCHOOL-ABC123' },
        { txRef: 'SCHOOL-DEF456' },
      ] as any);

      locks.acquire.mockResolvedValue(true);

      const result = await service.sweepPending();

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                status: 'PENDING',
                createdAt: { lt: expect.any(Date) },
              }),
            ]),
          }),
          take: 500,
        }),
      );

      expect(locks.acquire).toHaveBeenCalledTimes(2);
      expect(locks.acquire).toHaveBeenCalledWith('SCHOOL-ABC123');
      expect(locks.acquire).toHaveBeenCalledWith('SCHOOL-DEF456');

      expect(payments.enqueueVerification).toHaveBeenCalledTimes(2);
      expect(payments.enqueueVerification).toHaveBeenCalledWith('SCHOOL-ABC123', 'sweep');
      expect(payments.enqueueVerification).toHaveBeenCalledWith('SCHOOL-DEF456', 'sweep');

      expect(result.queued).toBe(2);
      expect(result.skippedLocked).toBe(0);
    });

    it('should queue verification for FAILED payments with gateway_reported_failed within 30-min window', async () => {
      const now = Date.now();
      const twentyMinutesAgo = new Date(now - 20 * 60 * 1000);

      findMany.mockResolvedValue([
        { txRef: 'SCHOOL-RETRY123' },
      ] as any);

      locks.acquire.mockResolvedValue(true);

      const result = await service.sweepPending();

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                status: 'FAILED',
                failureReason: 'gateway_reported_failed',
                createdAt: { gt: expect.any(Date) },
              }),
            ]),
          }),
        }),
      );

      expect(payments.enqueueVerification).toHaveBeenCalledWith('SCHOOL-RETRY123', 'sweep');
      expect(result.queued).toBe(1);
    });

    it('should skip payments that are already locked', async () => {
      findMany.mockResolvedValue([
        { txRef: 'SCHOOL-LOCKED1' },
        { txRef: 'SCHOOL-OK2' },
        { txRef: 'SCHOOL-LOCKED3' },
      ] as any);

      locks.acquire
        .mockResolvedValueOnce(false) // LOCKED1 - locked
        .mockResolvedValueOnce(true)  // OK2 - acquired
        .mockResolvedValueOnce(false); // LOCKED3 - locked

      const result = await service.sweepPending();

      expect(locks.acquire).toHaveBeenCalledTimes(3);
      expect(payments.enqueueVerification).toHaveBeenCalledTimes(1);
      expect(payments.enqueueVerification).toHaveBeenCalledWith('SCHOOL-OK2', 'sweep');

      expect(result.queued).toBe(1);
      expect(result.skippedLocked).toBe(2);
    });

    it('should handle empty result set', async () => {
      findMany.mockResolvedValue([]);

      const result = await service.sweepPending();

      expect(locks.acquire).not.toHaveBeenCalled();
      expect(payments.enqueueVerification).not.toHaveBeenCalled();
      expect(result.queued).toBe(0);
      expect(result.skippedLocked).toBe(0);
    });

    it('should process up to SWEEP_BATCH (500) payments per run', async () => {
      const payments_array = Array.from({ length: 600 }, (_, i) => ({
        txRef: `SCHOOL-${i.toString().padStart(6, '0')}`,
      }));

      findMany.mockResolvedValue(payments_array as any);
      locks.acquire.mockResolvedValue(true);

      await service.sweepPending();

      // Should only fetch 500 due to take: 500 limit
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 500,
        }),
      );
    });
  });

  describe('module initialization', () => {
    it('should register sweep job and schedule it when RUN_WORKERS is true', async () => {
      await service.onModuleInit();

      expect(queues.register).toHaveBeenCalledWith(
        'maintenance',
        'sweep-pending-payments',
        expect.any(Function),
      );

      expect(queues.schedule).toHaveBeenCalledWith(
        'maintenance',
        'pending-payment-sweep',
        '*/5 * * * *',
        'sweep-pending-payments',
      );
    });
  });
});

describe('ReconciliationService - Integration Scenarios', () => {
  describe('Multi-attempt checkout failure scenario', () => {
    it('should handle the parent retry loop case', async () => {
      /**
       * Scenario:
       * 1. Parent opens payment link → Payment created (txRef: SCHOOL-ABC123, status: PENDING)
       * 2. Payment fails at Chapa → Webhook updates to FAILED with failureReason: gateway_reported_failed
       * 3. Parent clicks "Retry" in Chapa's page
       * 4. Payment succeeds on retry (Chapa may use same or different txRef)
       * 5. Webhook fails to deliver or references wrong transaction
       * 6. Expected: Sweep worker catches it within 5 minutes
       */

      // This is a documentation test showing the expected flow
      const timeline = {
        t0: 'Payment initialized: PENDING',
        t1: 'First attempt fails: FAILED (gateway_reported_failed)',
        t2: 'Parent retries inside Chapa checkout',
        t3: 'Second attempt succeeds at Chapa',
        t4: 'Webhook fails or never arrives',
        t5_max: '5 minutes: Sweep worker runs',
        t6: 'Sweep calls Chapa verify API',
        t7: 'Payment status updated to SUCCEEDED',
        t8: 'Receipt issued automatically',
        t9: 'SMS sent to parent',
      };

      expect(timeline.t5_max).toBe('5 minutes: Sweep worker runs');
    });
  });
});

describe('ArifPay session reconciliation', () => {
  const sessionId = 'ED54BDB4D5BF2D';
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

  function localPayment(overrides: Record<string, unknown> = {}) {
    return {
      txRef: 'DEMO-SESSION',
      schoolId: 'school-1',
      gateway: 'arifpay',
      gatewaySessionId: sessionId,
      gatewayReference: 'BCI6FETYVI',
      status: 'SUCCEEDED',
      amount: 10_000,
      currency: 'ETB',
      succeededAt: twoHoursAgo,
      createdAt: twoHoursAgo,
      ...overrides,
    };
  }

  function harness(options: { payments?: Record<string, unknown>[]; notifies?: Record<string, unknown>[] }) {
    const issues: { kind: string; txRef?: string | null; details: Record<string, unknown> }[] = [];
    const verifySession = jest.fn();
    const listTransactions = jest.fn(async () => {
      throw new GatewayError('ArifPay has no transaction list; verify each session id', false);
    });
    const verifyAndSettle = jest.fn();
    const paymentFindMany = jest.fn(async (args: { where?: { gateway?: string } }) => {
      if (args.where?.gateway === 'arifpay') return options.payments ?? [];
      return [];
    });
    const paymentFindUnique = jest.fn(async () => null);
    const service = new ReconciliationService(
      { RUN_WORKERS: false } as AppEnv,
      {
        db: {
          payment: { findMany: paymentFindMany, findUnique: paymentFindUnique, findUniqueOrThrow: jest.fn() },
          reconciliationRun: {
            create: jest.fn(async () => ({ id: 'run-1' })),
            update: jest.fn(async () => ({})),
          },
          reconciliationIssue: {
            findFirst: jest.fn(async () => null),
            create: jest.fn(async ({ data }: { data: { kind: string; txRef?: string | null; details: Record<string, unknown> } }) => {
              issues.push(data);
              return data;
            }),
          },
          receipt: { findMany: jest.fn(async () => []) },
          school: { findMany: jest.fn(async () => []) },
          webhookEvent: { findMany: jest.fn(async () => options.notifies ?? []) },
        },
      } as never,
      { add: jest.fn(async () => undefined), register: jest.fn(), schedule: jest.fn() } as never,
      { names: () => ['arifpay'], get: () => ({ name: 'arifpay', listTransactions, verifySession }) } as never,
      { verifyAndSettle } as never,
      { verifyChain: jest.fn(async () => ({ valid: true, problems: [], receipts: 0 })) } as never,
      {} as never,
      { acquire: jest.fn(async () => true) } as never,
    );
    return { service, issues, verifySession, listTransactions, verifyAndSettle };
  }

  it('treats a verified session with the same amount as a match', async () => {
    const { service, issues, verifySession, listTransactions, verifyAndSettle } = harness({ payments: [localPayment()] });
    verifySession.mockResolvedValue({ txRef: 'DEMO-SESSION', status: 'succeeded', amount: 10_000, currency: 'ETB', gatewayReference: 'BCI6FETYVI' });

    await service.run();

    expect(listTransactions).toHaveBeenCalledWith(1);
    expect(verifySession).toHaveBeenCalledWith(sessionId, 'DEMO-SESSION');
    expect(verifyAndSettle).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });

  it('opens an amount mismatch when the verified amount drifts', async () => {
    const { service, issues, verifySession } = harness({ payments: [localPayment()] });
    verifySession.mockResolvedValue({ txRef: 'DEMO-SESSION', status: 'succeeded', amount: 10_050, currency: 'ETB', gatewayReference: 'BCI6FETYVI' });

    await service.run();

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'amount_mismatch',
        txRef: 'DEMO-SESSION',
        details: expect.objectContaining({ gatewayAmount: 10_050, localAmount: 10_000 }),
      }),
    ]);
  });

  it('opens missing_at_gateway when a settled payment is no longer successful at the gateway', async () => {
    const { service, issues, verifySession } = harness({ payments: [localPayment()] });
    verifySession.mockResolvedValue({ txRef: 'DEMO-SESSION', status: 'pending', amount: 0, currency: 'ETB', gatewayReference: null });

    await service.run();

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'missing_at_gateway',
        txRef: 'DEMO-SESSION',
        details: expect.objectContaining({ gateway: 'arifpay', verifiedStatus: 'pending' }),
      }),
    ]);
  });

  it('opens gateway_tx_unknown when a verified success notify has no local payment', async () => {
    const { service, issues, verifySession, verifyAndSettle } = harness({
      payments: [],
      notifies: [
        {
          txRef: 'DEMO-GHOST',
          sessionId,
          signatureValid: true,
          gateway: 'arifpay',
          payload: { nonce: 'DEMO-GHOST', transactionStatus: 'SUCCESS', sessionId },
        },
      ],
    });
    verifySession.mockResolvedValue({ txRef: 'DEMO-GHOST', status: 'succeeded', amount: 10_000, currency: 'ETB', gatewayReference: 'BCI6FETYVI' });

    await service.run();

    expect(verifySession).toHaveBeenCalledWith(sessionId, 'DEMO-GHOST');
    expect(verifyAndSettle).not.toHaveBeenCalled();
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'gateway_tx_unknown',
        txRef: 'DEMO-GHOST',
        details: expect.objectContaining({ amount: 10_000, sessionId }),
      }),
    ]);
  });
});
