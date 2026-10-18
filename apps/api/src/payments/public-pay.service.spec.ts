import { PublicPayService } from './public-pay.service';

const invoice = {
  id: 'inv_1',
  status: 'ISSUED',
  totalAmount: 150_000,
  paidAmount: 0,
  number: 'INV-1',
  term: null,
  currency: 'ETB',
  dueDate: new Date('2026-11-01'),
  school: { name: 'Demo', code: 'DEMO', logoUrl: null, status: 'ACTIVE', city: 'Addis Ababa' },
  student: { firstName: 'Sara', lastName: 'Bekele', code: 'S1', grade: '5', section: 'A' },
  lines: [],
  payments: [],
  receipts: [],
};

function payment(overrides: Record<string, unknown>) {
  return {
    txRef: 'DEMO-TX1',
    status: 'FAILED',
    amount: 150_000,
    method: null,
    payerPhone: '+251911223344',
    failureReason: 'gateway_reported_failed',
    createdAt: new Date(),
    invoiceId: invoice.id,
    receipt: null,
    ...overrides,
  };
}

function serviceFor(row: ReturnType<typeof payment>) {
  const add = jest.fn(async () => undefined);
  const service = new PublicPayService(
    {
      db: {
        invoice: { findUnique: async () => invoice },
        payment: { findFirst: async () => row },
      },
    } as never,
    { add } as never,
  );
  return { service, add };
}

describe('public pay status recheck', () => {
  it('asks the gateway to verify a recent card decline again', async () => {
    const { service, add } = serviceFor(payment({}));
    const status = await service.status(invoice.id, 'DEMO-TX1');
    expect(status.rechecking).toBe(true);
    expect(status.payment.status).toBe('FAILED');
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('does not recheck an initialization failure or a decline outside the checkout window', async () => {
    const initialized = serviceFor(payment({ failureReason: 'initialize_failed: down' }));
    await expect(initialized.service.status('token', 'DEMO-TX1')).resolves.toMatchObject({ rechecking: false });
    expect(initialized.add).not.toHaveBeenCalled();

    const old = serviceFor(payment({ createdAt: new Date(Date.now() - 31 * 60 * 1000) }));
    await expect(old.service.status('token', 'DEMO-TX1')).resolves.toMatchObject({ rechecking: false });
    expect(old.add).not.toHaveBeenCalled();
  });

  it('does not recheck a payment that already succeeded', async () => {
    const { service, add } = serviceFor(payment({ status: 'SUCCEEDED', failureReason: null }));
    await expect(service.status('token', 'DEMO-TX1')).resolves.toMatchObject({ rechecking: false, payment: { status: 'SUCCEEDED' } });
    expect(add).not.toHaveBeenCalled();
  });
});
