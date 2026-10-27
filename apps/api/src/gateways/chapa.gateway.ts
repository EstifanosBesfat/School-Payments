import { etbStringToSantim, normalizeEthiopianPhone, santimToEtbString, toLocalPhone } from '@payment/shared';
import { hmacSha256Hex, safeEqual, sha256Hex } from '../common/crypto.util';
import {
  type CreateSubaccountRequest,
  type GatewayBank,
  GatewayError,
  type GatewayTransactionSummary,
  type InitializePaymentRequest,
  type InitializePaymentResult,
  type ParsedWebhook,
  type PaymentGateway,
  type VerifiedPayer,
  type VerifiedStatus,
  type VerifiedTransaction,
} from './payment-gateway.interface';

interface ChapaEnvelope<T> {
  message?: unknown;
  status?: string;
  data?: T;
}

interface ChapaVerifyData {
  tx_ref?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
  reference?: string | null;
  method?: string | null;
  payment_method?: string | null;
  charge?: string | number | null;
  mode?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone_number?: string | null;
  email?: string | null;
}

/** Chapa returns the payer phone as local digits (251911...); the app stores E.164 when it can. */
function payerFrom(data: ChapaVerifyData): VerifiedPayer {
  const name = [data.first_name, data.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
  const rawPhone = typeof data.phone_number === 'string' ? data.phone_number.trim() : '';
  let phone: string | null = rawPhone || null;
  if (rawPhone) {
    try {
      phone = normalizeEthiopianPhone(rawPhone);
    } catch {
      phone = rawPhone;
    }
  }
  return {
    name: name || null,
    phone,
    email: typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null,
  };
}

export interface ChapaConfig {
  baseUrl: string;
  secretKey: string;
  webhookSecret: string;
  timeoutMs?: number;
}

/** Chapa limits customization text to letters, digits, spaces and . - _ */
function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[^A-Za-z0-9 .\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function mapStatus(status: string | undefined): VerifiedStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
    case 'successful':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'failed/cancelled':
      return 'failed';
    case 'refunded':
      return 'refunded';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export class ChapaGateway implements PaymentGateway {
  readonly name: string = 'chapa';

  constructor(private readonly config: ChapaConfig) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ChapaEnvelope<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20000),
      });
    } catch (error) {
      throw new GatewayError(`Chapa request failed: ${(error as Error).message}`, true);
    }
    const text = await response.text();
    let parsed: ChapaEnvelope<T>;
    try {
      parsed = text ? (JSON.parse(text) as ChapaEnvelope<T>) : {};
    } catch {
      throw new GatewayError(`Chapa returned non-JSON response (${response.status})`, response.status >= 500);
    }
    if (!response.ok) {
      const message = typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message ?? text);
      throw new GatewayError(`Chapa ${method} ${path} failed (${response.status}): ${message}`, response.status >= 500 || response.status === 429, parsed);
    }
    return parsed;
  }

  async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    const body: Record<string, unknown> = {
      amount: santimToEtbString(request.amount),
      currency: request.currency,
      first_name: sanitizeText(request.customer.firstName, 50) || 'Parent',
      last_name: sanitizeText(request.customer.lastName, 50) || 'Guardian',
      phone_number: toLocalPhone(request.customer.phone),
      tx_ref: request.txRef,
      callback_url: request.callbackUrl,
      return_url: request.returnUrl,
      customization: {
        title: sanitizeText(request.title, 16),
        description: sanitizeText(request.description, 50),
      },
      meta: {
        hide_receipt: false,
        payment_reason: sanitizeText(request.description, 50),
        invoices: request.lineItems?.map((item) => ({ key: item.label, value: item.value })),
      },
    };
    if (request.customer.email) body['email'] = request.customer.email;
    if (request.split) {
      body['subaccounts'] = {
        id: request.split.subaccountId,
        split_type: request.split.type,
        split_value:
          request.split.type === 'flat' ? Number(santimToEtbString(request.split.value)) : request.split.value,
      };
    }
    const result = await this.request<{ checkout_url?: string }>('POST', '/transaction/initialize', body);
    const checkoutUrl = result.data?.checkout_url;
    if (result.status !== 'success' || !checkoutUrl) {
      throw new GatewayError('Chapa did not return a checkout URL', false, result);
    }
    return { checkoutUrl };
  }

  async verify(txRef: string): Promise<VerifiedTransaction> {
    let result: ChapaEnvelope<ChapaVerifyData>;
    try {
      result = await this.request<ChapaVerifyData>('GET', `/transaction/verify/${encodeURIComponent(txRef)}`);
    } catch (error) {
      if (error instanceof GatewayError && !error.retryable) {
        return { txRef, status: 'pending', amount: 0, currency: 'ETB', gatewayReference: null, method: null, fee: null, mode: null, raw: error.details ?? null };
      }
      throw error;
    }
    const data = result.data ?? {};
    if (data.tx_ref && data.tx_ref !== txRef) {
      throw new GatewayError('Chapa verify returned a different tx_ref', false, result);
    }
    return {
      txRef,
      status: mapStatus(data.status),
      amount: data.amount === undefined ? 0 : etbStringToSantim(String(data.amount)),
      currency: data.currency ?? 'ETB',
      gatewayReference: data.reference ?? null,
      method: data.payment_method ?? data.method ?? null,
      fee: data.charge === undefined || data.charge === null ? null : etbStringToSantim(String(data.charge)),
      mode: data.mode === 'live' || data.mode === 'test' ? data.mode : null,
      payer: payerFrom(data),
      raw: result,
    };
  }

  /**
   * Chapa sends `x-chapa-signature` = HMAC-SHA256(payload, secret) and `chapa-signature` =
   * HMAC-SHA256(secret, secret). Either valid header is accepted, per Chapa's documentation.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const payloadSignature = headerValue(headers, 'x-chapa-signature');
    const secretSignature = headerValue(headers, 'chapa-signature');
    const secret = this.config.webhookSecret;
    const candidates = [hmacSha256Hex(secret, rawBody), hmacSha256Hex(secret, JSON.stringify(payload))];
    const payloadValid = payloadSignature ? candidates.some((candidate) => safeEqual(candidate, payloadSignature)) : false;
    const secretValid = secretSignature ? safeEqual(hmacSha256Hex(secret, secret), secretSignature) : false;

    const eventType = typeof payload['event'] === 'string' ? payload['event'] : 'unknown';
    const txRef = typeof payload['tx_ref'] === 'string' ? payload['tx_ref'] : null;
    const status = typeof payload['status'] === 'string' ? payload['status'] : '';
    const reference = typeof payload['reference'] === 'string' ? payload['reference'] : '';
    return {
      signatureValid: payloadValid || secretValid,
      eventKey: `${this.name}:${eventType}:${txRef ?? reference}:${status}:${sha256Hex(rawBody).slice(0, 16)}`,
      eventType,
      txRef,
      payload,
    };
  }

  async createSubaccount(request: CreateSubaccountRequest): Promise<{ subaccountId: string }> {
    const result = await this.request<{ subaccount_id?: string; id?: string }>('POST', '/subaccount', {
      business_name: sanitizeText(request.businessName, 100),
      account_name: request.accountName,
      bank_code: request.bankCode,
      account_number: request.accountNumber,
      split_type: request.splitType,
      split_value:
        request.splitType === 'flat' ? Number(santimToEtbString(request.splitValue)) : request.splitValue,
    });
    const subaccountId = result.data?.subaccount_id ?? result.data?.id;
    if (!subaccountId) throw new GatewayError('Chapa did not return a subaccount id', false, result);
    return { subaccountId };
  }

  async listBanks(): Promise<GatewayBank[]> {
    const result = await this.request<{ id: number; name: string }[]>('GET', '/banks');
    return (result.data ?? []).map((bank) => ({ id: bank.id, name: bank.name }));
  }

  async listTransactions(page: number): Promise<{ transactions: GatewayTransactionSummary[]; hasMore: boolean }> {
    const result = await this.request<{
      transactions?: {
        ref_id?: string;
        tx_ref?: string;
        trx_ref?: string;
        status?: string;
        amount?: string;
        currency?: string;
        created_at?: string;
      }[];
      pagination?: { next_page_url?: string | null };
    }>('GET', `/transactions?page=${page}`);
    const transactions = (result.data?.transactions ?? []).map((item) => ({
      reference: item.ref_id ?? '',
      txRef: item.tx_ref ?? item.trx_ref ?? null,
      status: mapStatus(item.status),
      amount: item.amount ? etbStringToSantim(String(item.amount)) : 0,
      currency: item.currency ?? 'ETB',
      createdAt: item.created_at ?? '',
    }));
    return { transactions, hasMore: Boolean(result.data?.pagination?.next_page_url) };
  }
}
