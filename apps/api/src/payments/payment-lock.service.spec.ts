import { PAYMENT_LOCK_TTL_SECONDS, PaymentLockService, paymentLockKey } from './payment-lock.service';

describe('PaymentLockService', () => {
  function harness() {
    const set = jest.fn();
    const del = jest.fn(async () => 1);
    const service = new PaymentLockService({ connection: { set, del } } as never);
    return { service, set, del };
  }

  it('takes a 10 second NX lock keyed by tx_ref', async () => {
    const { service, set } = harness();
    set.mockResolvedValueOnce('OK');
    await expect(service.acquire('DEMO-TX1')).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(paymentLockKey('DEMO-TX1'), '1', 'EX', PAYMENT_LOCK_TTL_SECONDS, 'NX');
    expect(PAYMENT_LOCK_TTL_SECONDS).toBe(10);
  });

  it('reports a lock that is already held', async () => {
    const { service, set } = harness();
    set.mockResolvedValueOnce(null);
    await expect(service.acquire('DEMO-TX1')).resolves.toBe(false);
  });

  it('fails open when Redis cannot answer, so a paid transaction is still verified', async () => {
    const { service, set } = harness();
    set.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(service.acquire('DEMO-TX1')).resolves.toBe(true);
  });

  it('releases the key after a duplicate delivery that this caller will not process', async () => {
    const { service, del } = harness();
    await service.release('DEMO-TX1');
    expect(del).toHaveBeenCalledWith(paymentLockKey('DEMO-TX1'));
  });
});
