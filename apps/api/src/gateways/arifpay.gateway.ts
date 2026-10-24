import { etbStringToSantim, santimToEtbString, toInternationalDigits } from '@payment/shared';
import { sha256Hex } from '../common/crypto.util';
import {
  type CreateSubaccountRequest,
  type DirectPayRequest,
  type DirectPayResult,
  type GatewayBank,
  GatewayError,
  type GatewayTransactionSummary,
  type InitializePaymentRequest,
  type InitializePaymentResult,
  type ParsedWebhook,
  type PayerRail,
  type PaymentGateway,
  type VerifiedStatus,
  type VerifiedTransaction,
} from './payment-gateway.interface';

const RAIL_PATH: Record<PayerRail, string> = {
  telebirr: '/api/checkout/telebirr-ussd/transfer/direct',
  cbe_birr: '/api/checkout/v2/cbe/direct/transfer',
};

interface ArifpayEnvelope {
  error?: boolean;
  msg?: string;
  data?: unknown;
}

export interface ArifpayGatewayConfig {
  baseUrl: string;
  apiKey: string;
  sandbox: boolean;
}

function etbNumber(santim: number): number {
  return Number(santimToEtbString(santim));
}

function expireStamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function terminalKind(msg: string): 'duplicate' | 'success' | 'failed' | 'expired' | 'missing' | null {
  const text = msg.trim().toLowerCase().replace(/\.$/, '');
  if (text === 'session already exist') return 'duplicate';
  if (text === 'the checkout is already successful') return 'success';
  if (text === 'the checkout is already failed') return 'failed';
  if (text === 'session expired') return 'expired';
  if (text === 'no session found') return 'missing';
  return null;
}

function sessionIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const nested = record['data'];
  const source = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : record;
  const sessionId = source['sessionId'] ?? source['uuid'] ?? source['session'];
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function mapPaymentType(paymentType: string | null): string | null {
  if (!paymentType) return null;
  const normalized = paymentType.toUpperCase();
  if (normalized === 'TELEBIRR_USSD' || normalized === 'TELEBIRR') return 'telebirr';
  if (normalized === 'CBE' || normalized === 'CBEBIRR') return 'cbe_birr';
  return paymentType.toLowerCase();
}

function mapStatus(status: string | undefined): VerifiedStatus {
  const normalized = (status ?? '').toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'SUCCESSFUL') return 'succeeded';
  if (normalized === 'PENDING') return 'pending';
  if (normalized === 'FAILED' || normalized === 'CANCELED' || normalized === 'CANCELLED' || normalized === 'EXPIRED') return 'failed';
  return 'pending';
}

export class ArifPayGateway implements PaymentGateway {
  readonly name = 'arifpay';

  constructor(private readonly config: ArifpayGatewayConfig) {}

  async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    const body = this.checkoutBody({
      txRef: request.txRef,
      amount: request.amount,
      currency: 'ETB',
      method: 'telebirr',
      phone: `+251${'9'.padEnd(9, '0')}`,
      email: request.customer.email ?? 'fees@example.com',
      notifyUrl: request.callbackUrl,
      returnUrl: request.returnUrl,
      title: request.title,
      description: request.description,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    delete body['phone'];
    const result = await this.request('POST', '/api/checkout/session', body);
    const session = this.readEnvelope(result, 'POST', '/api/checkout/session');
    const data = session.data && typeof session.data === 'object' ? (session.data as Record<string, unknown>) : {};
    const checkoutUrl = typeof data['paymentUrl'] === 'string' ? data['paymentUrl'] : '';
    if (!checkoutUrl) throw new GatewayError('ArifPay did not return a checkout URL', false);
    return { checkoutUrl };
  }

  async directPay(request: DirectPayRequest): Promise<DirectPayResult> {
    const path = RAIL_PATH[request.method];
    const body = this.checkoutBody(request);
    const result = await this.request('POST', path, body);
    const envelope = this.readEnvelope(result, 'POST', path);
    const kind = terminalKind(envelope.msg ?? '');
    if (kind === 'duplicate' || kind === 'success' || kind === 'failed') {
      const existing = await this.lookupByNonce(request.txRef);
      return {
        sessionId: existing,
        expiresAt: request.expiresAt.toISOString(),
        alreadySucceeded: kind === 'success',
        alreadyFailed: kind === 'failed',
      };
    }
    if (envelope.error) {
      throw new GatewayError(this.safeMessage('POST', path, result.status, envelope.msg ?? 'request failed'), this.retryable(result.status, envelope.msg ?? ''));
    }
    const sessionId = sessionIdOf(envelope);
    if (!sessionId) throw new GatewayError('ArifPay did not return a session id', false);
    return { sessionId, expiresAt: request.expiresAt.toISOString(), alreadySucceeded: false, alreadyFailed: false };
  }

  async verify(txRef: string): Promise<VerifiedTransaction> {
    const sessionId = await this.lookupByNonce(txRef);
    return this.verifySession(sessionId, txRef);
  }

  async verifySession(sessionId: string, txRef: string): Promise<VerifiedTransaction> {
    const path = `/api/verify/transaction?uuid=${encodeURIComponent(sessionId)}`;
    const result = await this.request('GET', path);
    let rows: unknown;
    try {
      rows = result.text ? JSON.parse(result.text) : [];
    } catch {
      throw new GatewayError('ArifPay verify returned non-JSON', result.status >= 500);
    }
    if (!Array.isArray(rows)) {
      const envelope = rows as ArifpayEnvelope;
      if (envelope && typeof envelope === 'object' && envelope.error) {
        const kind = terminalKind(envelope.msg ?? '');
        if (kind === 'missing') return this.pending(txRef, rows);
        throw new GatewayError(this.safeMessage('GET', path, result.status, envelope.msg ?? 'verify failed'), this.retryable(result.status, envelope.msg ?? ''));
      }
      throw new GatewayError('ArifPay verify returned an unexpected body', result.status >= 500);
    }
    if (rows.length === 0) return this.pending(txRef, rows);
    const matches = rows.filter((row) => row && typeof row === 'object' && (row as Record<string, unknown>)['nonce'] === txRef);
    if (matches.length === 0) {
      throw new GatewayError('ArifPay verify returned a different nonce', false);
    }
    const chosen = matches.find((row) => mapStatus(String((row as Record<string, unknown>)['status'] ?? '')) === 'succeeded') ?? matches[0];
    const data = chosen as Record<string, unknown>;
    const amount = typeof data['amount'] === 'number' || typeof data['amount'] === 'string' ? etbStringToSantim(String(data['amount'])) : 0;
    const paymentType = typeof data['paymentType'] === 'string' ? data['paymentType'] : null;
    const transactionId = typeof data['transactionId'] === 'string' && data['transactionId'].length > 0 ? data['transactionId'] : null;
    return {
      txRef,
      status: mapStatus(typeof data['status'] === 'string' ? data['status'] : undefined),
      amount,
      currency: 'ETB',
      gatewayReference: transactionId,
      method: mapPaymentType(paymentType),
      fee: null,
      mode: this.config.sandbox ? 'test' : 'live',
      raw: rows,
    };
  }

  parseWebhook(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    let payload: Record<string, unknown> = {};
    let parsed = false;
    try {
      const value = JSON.parse(rawBody.toString('utf8')) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        payload = value as Record<string, unknown>;
        parsed = true;
      }
    } catch {
      parsed = false;
    }
    const txRef = typeof payload['nonce'] === 'string' && payload['nonce'].length > 0 ? payload['nonce'] : null;
    const sessionCandidate = payload['sessionId'] ?? payload['uuid'];
    const sessionId = typeof sessionCandidate === 'string' && sessionCandidate.length > 0 ? sessionCandidate : null;
    const status = typeof payload['transactionStatus'] === 'string' ? payload['transactionStatus'] : 'unknown';
    return {
      signatureValid: parsed && txRef !== null,
      eventKey: `arifpay:${txRef ?? 'none'}:${status}:${sha256Hex(rawBody).slice(0, 16)}`,
      eventType: status,
      txRef,
      sessionId,
      payload,
    };
  }

  async createSubaccount(_request: CreateSubaccountRequest): Promise<{ subaccountId: string }> {
    throw new GatewayError('ArifPay payout accounts are sent on each payment as beneficiaries', false);
  }

  async listBanks(): Promise<GatewayBank[]> {
    return [];
  }

  async listTransactions(_page: number): Promise<{ transactions: GatewayTransactionSummary[]; hasMore: boolean }> {
    throw new GatewayError('ArifPay has no transaction list; verify each session id', false);
  }

  private checkoutBody(request: DirectPayRequest): Record<string, unknown> {
    const price = etbNumber(request.amount);
    const body: Record<string, unknown> = {
      cancelUrl: request.returnUrl,
      phone: toInternationalDigits(request.phone),
      email: request.email,
      nonce: request.txRef,
      successUrl: request.returnUrl,
      errorUrl: request.returnUrl,
      notifyUrl: request.notifyUrl,
      expireDate: expireStamp(request.expiresAt),
      items: [{ name: request.title, quantity: 1, price, description: request.description }],
      lang: 'EN',
      currency: request.currency,
    };
    if (request.beneficiary) {
      body['beneficiaries'] = [
        {
          accountNumber: request.beneficiary.accountNumber,
          bank: request.beneficiary.bank,
          amount: etbNumber(request.beneficiary.amount),
        },
      ];
    }
    return body;
  }

  private async lookupByNonce(txRef: string): Promise<string> {
    const path = `/api/checkout/getSessionByNonce/${encodeURIComponent(txRef)}`;
    const result = await this.request('GET', path);
    let body: unknown = null;
    try {
      body = result.text ? JSON.parse(result.text) : null;
    } catch {
      throw new GatewayError('ArifPay session lookup returned non-JSON', result.status >= 500);
    }
    const sessionId = sessionIdOf(body);
    if (!sessionId) throw new GatewayError('ArifPay session already exists but could not be loaded', false);
    return sessionId;
  }

  private pending(txRef: string, raw: unknown): VerifiedTransaction {
    return {
      txRef,
      status: 'pending',
      amount: 0,
      currency: 'ETB',
      gatewayReference: null,
      method: null,
      fee: null,
      mode: this.config.sandbox ? 'test' : 'live',
      raw,
    };
  }

  private readEnvelope(result: { status: number; text: string }, method: string, path: string): ArifpayEnvelope {
    let envelope: ArifpayEnvelope;
    try {
      envelope = result.text ? (JSON.parse(result.text) as ArifpayEnvelope) : {};
    } catch {
      throw new GatewayError(`ArifPay returned non-JSON response (${result.status})`, result.status >= 500);
    }
    if (result.status >= 500) {
      throw new GatewayError(this.safeMessage(method, path, result.status, envelope.msg ?? 'internal system error'), true);
    }
    if (result.status === 401 || result.status === 403) {
      throw new GatewayError(this.safeMessage(method, path, result.status, envelope.msg ?? 'rejected'), false);
    }
    return envelope;
  }

  private retryable(status: number, msg: string): boolean {
    if (status >= 500 || status === 429) return true;
    return msg.toLowerCase().includes('internal system error');
  }

  private safeMessage(method: string, path: string, status: number, msg: string): string {
    const cleaned = msg.replace(/\+?251\d{8,12}/g, '[phone]');
    return `ArifPay ${method} ${path.split('?')[0]} failed (${status}): ${cleaned}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          'x-arifpay-key': this.config.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new GatewayError(`ArifPay ${method} ${path.split('?')[0]} could not be reached`, true, error instanceof Error ? error.name : undefined);
    }
    return { status: response.status, text: await response.text() };
  }
}
