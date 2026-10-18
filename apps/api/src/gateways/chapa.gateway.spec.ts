import { createHmac } from 'node:crypto';
import { ChapaGateway } from './chapa.gateway';

const secret = 'test-webhook-secret';
const gateway = new ChapaGateway({ baseUrl: 'https://api.chapa.co/v1', secretKey: 'CHASECK_TEST-x', webhookSecret: secret });

function sign(value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

describe('ChapaGateway.parseWebhook', () => {
  const body = JSON.stringify({ event: 'charge.success', tx_ref: 'DEMO-ABC', status: 'success', amount: '400.00', reference: 'AP1' });

  it('accepts a valid x-chapa-signature over the raw body', () => {
    const parsed = gateway.parseWebhook(Buffer.from(body), { 'x-chapa-signature': sign(body) });
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.txRef).toBe('DEMO-ABC');
    expect(parsed.eventType).toBe('charge.success');
  });

  it('accepts a valid chapa-signature (HMAC of the secret)', () => {
    const parsed = gateway.parseWebhook(Buffer.from(body), { 'chapa-signature': sign(secret) });
    expect(parsed.signatureValid).toBe(true);
  });

  it('rejects a wrong or missing signature', () => {
    expect(gateway.parseWebhook(Buffer.from(body), { 'x-chapa-signature': sign('tampered') }).signatureValid).toBe(false);
    expect(gateway.parseWebhook(Buffer.from(body), {}).signatureValid).toBe(false);
  });

  it('produces the same event key for a redelivered event', () => {
    const first = gateway.parseWebhook(Buffer.from(body), { 'x-chapa-signature': sign(body) });
    const second = gateway.parseWebhook(Buffer.from(body), { 'x-chapa-signature': sign(body) });
    expect(first.eventKey).toBe(second.eventKey);
  });

  it('uses a different event key when the same tx_ref changes from failed to success', () => {
    const failed = JSON.stringify({ event: 'charge.failed/cancelled', tx_ref: 'DEMO-ABC', status: 'failed/cancelled', reference: 'AP1' });
    const success = JSON.stringify({ event: 'charge.success', tx_ref: 'DEMO-ABC', status: 'success', reference: 'AP1' });
    const failedKey = gateway.parseWebhook(Buffer.from(failed), { 'x-chapa-signature': sign(failed) }).eventKey;
    const successKey = gateway.parseWebhook(Buffer.from(success), { 'x-chapa-signature': sign(success) }).eventKey;
    expect(failedKey).not.toBe(successKey);
    expect(gateway.parseWebhook(Buffer.from(failed), { 'x-chapa-signature': sign(failed) }).eventKey).toBe(failedKey);
  });
});

describe('ChapaGateway.verify', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps a successful verify response to santim', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: { tx_ref: 'DEMO-ABC', status: 'success', amount: '1500.50', currency: 'ETB', reference: 'AP9', method: 'telebirr', charge: '45.02', mode: 'test' },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const result = await gateway.verify('DEMO-ABC');
    expect(result).toMatchObject({ status: 'succeeded', amount: 150050, fee: 4502, gatewayReference: 'AP9', method: 'telebirr', mode: 'test' });
  });

  it('maps a failed card attempt, then a later success for the same tx_ref', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', data: { tx_ref: 'DEMO-ABC', status: 'failed', amount: '100.00', currency: 'ETB' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'success', data: { tx_ref: 'DEMO-ABC', status: 'success', amount: '100.00', currency: 'ETB', reference: 'AP9', payment_method: 'card' } }),
          { status: 200 },
        ),
      );
    global.fetch = fetchMock as typeof fetch;
    await expect(gateway.verify('DEMO-ABC')).resolves.toMatchObject({ txRef: 'DEMO-ABC', status: 'failed', amount: 10000 });
    await expect(gateway.verify('DEMO-ABC')).resolves.toMatchObject({ txRef: 'DEMO-ABC', status: 'succeeded', amount: 10000, gatewayReference: 'AP9', method: 'card' });
  });

  it('maps a cancelled verify to failed and does not treat a transport error as success', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { tx_ref: 'DEMO-ABC', status: 'failed/cancelled', amount: '100.00', currency: 'ETB' } }), { status: 200 }),
    ) as typeof fetch;
    await expect(gateway.verify('DEMO-ABC')).resolves.toMatchObject({ status: 'failed' });

    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up')) as typeof fetch;
    await expect(gateway.verify('DEMO-ABC')).rejects.toThrow('socket hang up');
  });

  it('lists a Chapa success as succeeded so reconciliation can match it', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            transactions: [{ ref_id: 'AP1', tx_ref: 'DEMO-ABC', status: 'success', amount: '10.00', currency: 'ETB', created_at: '2026-10-18T00:00:00.000Z' }],
            pagination: { next_page_url: null },
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const listed = await gateway.listTransactions(1);
    expect(listed.transactions[0]).toMatchObject({ txRef: 'DEMO-ABC', status: 'succeeded', amount: 1000, currency: 'ETB' });
  });

  it('rejects a verify response for a different tx_ref', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { tx_ref: 'OTHER', status: 'success', amount: '1' } }), { status: 200 }),
    ) as typeof fetch;
    await expect(gateway.verify('DEMO-ABC')).rejects.toThrow('different tx_ref');
  });
});
