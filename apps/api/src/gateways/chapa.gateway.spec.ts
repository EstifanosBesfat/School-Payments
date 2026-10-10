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

  it('rejects a verify response for a different tx_ref', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { tx_ref: 'OTHER', status: 'success', amount: '1' } }), { status: 200 }),
    ) as typeof fetch;
    await expect(gateway.verify('DEMO-ABC')).rejects.toThrow('different tx_ref');
  });
});
