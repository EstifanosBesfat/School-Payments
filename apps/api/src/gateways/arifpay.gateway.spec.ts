import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ArifPayGateway, type ArifpayGatewayConfig } from './arifpay.gateway';
import { GatewayError, type DirectPayRequest } from './payment-gateway.interface';

const config: ArifpayGatewayConfig = {
  baseUrl: 'https://gateway.arifpay.org',
  apiKey: 'sandbox-key-not-a-real-secret',
  sandbox: true,
};
const gateway = new ArifPayGateway(config);

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, '__fixtures__', 'arifpay', name), 'utf8');
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

const directRequest: DirectPayRequest = {
  txRef: 'DEMO-ABC',
  amount: 10_000,
  currency: 'ETB',
  method: 'telebirr',
  phone: '+251912345678',
  email: 'fees@school.example',
  notifyUrl: 'https://api.school.example/webhooks/arifpay',
  returnUrl: 'https://school.example/pay/token/return',
  title: 'School fees',
  description: 'DEMO INV-0001',
  expiresAt: new Date('2026-10-24T20:00:00.000Z'),
  beneficiary: { accountNumber: '1000000000000', bank: 'AWINETAA', amount: 10_000 },
};

describe('ArifPayGateway.directPay', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends Telebirr as a single USSD request with our nonce and an ETB amount', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(fixture('telebirr-direct-pending.json')));
    global.fetch = fetchMock as typeof fetch;
    const result = await gateway.directPay(directRequest);
    expect(result).toEqual({
      sessionId: 'ED54BDB4D5BF2D',
      expiresAt: '2026-10-24T20:00:00.000Z',
      alreadySucceeded: false,
      alreadyFailed: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.arifpay.org/api/checkout/telebirr-ussd/transfer/direct');
    expect(init.headers).toMatchObject({ 'x-arifpay-key': config.apiKey });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      nonce: 'DEMO-ABC',
      phone: '251912345678',
      currency: 'ETB',
      expireDate: '2026-10-24T20:00:00',
      notifyUrl: directRequest.notifyUrl,
    });
    expect(body['items']).toEqual([{ name: 'School fees', quantity: 1, price: 100, description: 'DEMO INV-0001' }]);
    expect(body['beneficiaries']).toEqual([{ accountNumber: '1000000000000', bank: 'AWINETAA', amount: 100 }]);
    expect(JSON.stringify(body)).not.toContain(config.apiKey);
    expect(JSON.stringify(body)).not.toContain('+251912345678');
  });

  it('sends CBE Birr to the v2 direct transfer path and omits beneficiaries when the school has no payout account', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(fixture('cbe-direct-pending.json')));
    global.fetch = fetchMock as typeof fetch;
    const { beneficiary: _beneficiary, ...withoutAccount } = directRequest;
    await gateway.directPay({ ...withoutAccount, method: 'cbe_birr', amount: 150_050 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.arifpay.org/api/checkout/v2/cbe/direct/transfer');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['beneficiaries']).toBeUndefined();
    expect(body['items']).toEqual([{ name: 'School fees', quantity: 1, price: 1500.5, description: 'DEMO INV-0001' }]);
    expect(body['phone']).toBe('251912345678');
  });

  it('loads the existing session when the nonce was already used', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(fixture('session-already-exist.json'), 400))
      .mockResolvedValueOnce(
        jsonResponse(JSON.stringify({ error: false, msg: 'No Errors', data: { sessionId: 'ED54BDB4D5BF2D', nonce: 'DEMO-ABC' } })),
      );
    global.fetch = fetchMock as typeof fetch;
    const result = await gateway.directPay(directRequest);
    expect(result.sessionId).toBe('ED54BDB4D5BF2D');
    expect(result.alreadySucceeded).toBe(false);
    const [lookupUrl] = fetchMock.mock.calls[1] as [string];
    expect(lookupUrl).toBe('https://gateway.arifpay.org/api/checkout/getSessionByNonce/DEMO-ABC');
  });

  it('reports an already successful checkout so the caller verifies instead of creating another attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(fixture('checkout-already-successful.json')))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ data: { uuid: 'ED54BDB4D5BF2D' } })));
    global.fetch = fetchMock as typeof fetch;
    await expect(gateway.directPay(directRequest)).resolves.toMatchObject({ sessionId: 'ED54BDB4D5BF2D', alreadySucceeded: true });
  });

  it('reports an already failed checkout without a new session', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(fixture('checkout-already-failed.json')))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ sessionId: 'ED54BDB4D5BF2D' })));
    global.fetch = fetchMock as typeof fetch;
    await expect(gateway.directPay(directRequest)).resolves.toMatchObject({ alreadyFailed: true, alreadySucceeded: false });
  });

  it('treats validation and auth failures as final and hides the key and phone', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('validation-error.json'), 400)) as typeof fetch;
    await expect(gateway.directPay(directRequest)).rejects.toMatchObject({ retryable: false });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('error-unauthorized.json'), 401)) as typeof fetch;
    try {
      await gateway.directPay(directRequest);
      throw new Error('expected auth failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(config.apiKey);
      expect(message).not.toContain('251912345678');
      expect(message).not.toContain('+251');
    }
  });

  it('retries server and transport failures', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('error-server.json'), 500)) as typeof fetch;
    await expect(gateway.directPay(directRequest)).rejects.toMatchObject({ retryable: true });
    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up')) as typeof fetch;
    await expect(gateway.directPay(directRequest)).rejects.toMatchObject({ retryable: true });
    global.fetch = jest.fn().mockResolvedValue(new Response('<html>down</html>', { status: 502 })) as typeof fetch;
    await expect(gateway.directPay(directRequest)).rejects.toMatchObject({ retryable: true });
  });
});

describe('ArifPayGateway.verifySession', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps a successful verify array into santim', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-success.json'))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({
      txRef: 'DEMO-ABC',
      status: 'succeeded',
      amount: 10_000,
      gatewayReference: 'BCI6FETYVI',
      method: 'telebirr',
      mode: 'test',
    });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/verify/transaction?uuid=ED54BDB4D5BF2D');
    expect(init.headers).toMatchObject({ 'x-arifpay-key': config.apiKey });
  });

  it('maps failed, canceled, and expired rows, including the one-L and two-L spellings', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-failed.json'))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({ status: 'failed', amount: 150_050, method: 'cbe_birr' });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-canceled.json'))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({ status: 'failed' });
    const cancelled = fixture('verify-canceled.json').replace('CANCELED', 'CANCELLED');
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(cancelled)) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({ status: 'failed' });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-expired.json'))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({ status: 'failed' });
  });

  it('stays pending when the session is unknown or still open', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-unknown.json'))) as typeof fetch;
    await expect(gateway.verifySession('missing', 'DEMO-ABC')).resolves.toMatchObject({ status: 'pending', amount: 0 });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-pending.json'))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({ status: 'pending', amount: 10_000 });
  });

  it('refuses a verify payload whose nonce is not ours', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(fixture('verify-success.json'))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'OTHER')).rejects.toThrow(/different nonce/);
  });

  it('prefers a success row when the same nonce has an older failure', async () => {
    const rows = [
      { paymentType: 'TELEBIRR_USSD', amount: 100, status: 'FAILED', nonce: 'DEMO-ABC', transactionId: null },
      { paymentType: 'TELEBIRR_USSD', amount: 100, status: 'SUCCESS', nonce: 'DEMO-ABC', transactionId: 'BCI6FETYVI' },
    ];
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(JSON.stringify(rows))) as typeof fetch;
    await expect(gateway.verifySession('ED54BDB4D5BF2D', 'DEMO-ABC')).resolves.toMatchObject({ status: 'succeeded', gatewayReference: 'BCI6FETYVI' });
  });
});

describe('ArifPayGateway.parseWebhook', () => {
  it('reads the nonce and session id from a raw notify body', () => {
    const body = fixture('notify-success.json');
    const parsed = gateway.parseWebhook(Buffer.from(body), {});
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.txRef).toBe('DEMO-ABC');
    expect(parsed.sessionId).toBe('ED54BDB4D5BF2D');
    expect(parsed.eventType).toBe('SUCCESS');
    expect(JSON.stringify(parsed.eventKey)).not.toContain('251911111111');
  });

  it('keeps the same event key for a redelivery and a new key when the status changes', () => {
    const success = fixture('notify-success.json');
    const failed = fixture('notify-failed.json');
    const first = gateway.parseWebhook(Buffer.from(success), {});
    const second = gateway.parseWebhook(Buffer.from(success), {});
    expect(first.eventKey).toBe(second.eventKey);
    expect(gateway.parseWebhook(Buffer.from(failed), {}).eventKey).not.toBe(first.eventKey);
  });

  it('rejects a body that is not a notify object', () => {
    expect(gateway.parseWebhook(Buffer.from('not-json'), {}).signatureValid).toBe(false);
    expect(gateway.parseWebhook(Buffer.from('[]'), {}).txRef).toBeNull();
    expect(gateway.parseWebhook(Buffer.from('{}'), {}).signatureValid).toBe(false);
  });

  it('accepts a canceled notify', () => {
    const parsed = gateway.parseWebhook(Buffer.from(fixture('notify-canceled.json')), {});
    expect(parsed.eventType).toBe('CANCELED');
    expect(parsed.txRef).toBe('DEMO-ABC');
  });
});
