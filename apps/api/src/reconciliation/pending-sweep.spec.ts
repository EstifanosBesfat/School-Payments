import type { AppEnv } from '../config/config.module';
import { ReconciliationService } from './reconciliation.service';

describe('pending payment sweep', () => {
  function harness(rows: { txRef: string }[]) {
    const findMany = jest.fn(async () => rows);
    const acquire = jest.fn(async () => true);
    const enqueueVerification = jest.fn(async () => undefined);
    const service = new ReconciliationService(
      { RUN_WORKERS: false } as AppEnv,
      { db: { payment: { findMany } } } as never,
      { register: jest.fn(), schedule: jest.fn() } as never,
      { names: () => [] } as never,
      { enqueueVerification } as never,
      {} as never,
      {} as never,
      { acquire } as never,
    );
    return { service, findMany, acquire, enqueueVerification };
  }

  it('queues a verify for an old pending attempt the notify never confirmed', async () => {
    const { service, findMany, enqueueVerification } = harness([{ txRef: 'DEMO-SWEEP' }]);
    await expect(service.sweepPending()).resolves.toEqual({ queued: 1, skippedLocked: 0 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([expect.objectContaining({ status: 'PENDING' })]),
        }),
      }),
    );
    expect(enqueueVerification).toHaveBeenCalledWith('DEMO-SWEEP', 'sweep');
  });

  it('leaves a tx_ref locked by an in-flight notify for that notify to finish', async () => {
    const { service, acquire, enqueueVerification } = harness([{ txRef: 'DEMO-LOCKED' }]);
    acquire.mockResolvedValueOnce(false);
    await expect(service.sweepPending()).resolves.toEqual({ queued: 0, skippedLocked: 1 });
    expect(enqueueVerification).not.toHaveBeenCalled();
  });
});
