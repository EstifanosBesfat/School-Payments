import type { Redis } from 'ioredis';
import { hmacSha256Hex } from '../common/crypto.util';
import { ChapaGateway } from './chapa.gateway';
import type {
  CreateSubaccountRequest,
  DirectPayRequest,
  DirectPayResult,
  GatewayBank,
  GatewayTransactionSummary,
  InitializePaymentRequest,
  InitializePaymentResult,
  VerifiedTransaction,
} from './payment-gateway.interface';

interface MockTransaction {
  txRef: string;
  amount: number;
  currency: string;
  status: 'pending' | 'success' | 'failed';
  method: string | null;
  returnUrl: string;
  title: string;
  description: string;
  customerName: string;
  createdAt: string;
}

const KEY_PREFIX = 'mockgw:tx:';
const TTL_SECONDS = 7 * 24 * 3600;

/**
 * Local stand-in for Chapa so the full flow (checkout, signed webhook, verify, receipt) runs
 * without real keys. It signs webhooks exactly like Chapa, so the same verification code runs.
 * Refused at startup when NODE_ENV=production.
 */
export class MockGateway extends ChapaGateway {
  override readonly name: string = 'mock';

  constructor(
    private readonly redis: Redis,
    private readonly options: { webUrl: string; apiUrl: string; webhookSecret: string },
  ) {
    super({ baseUrl: 'http://mock.invalid', secretKey: 'mock', webhookSecret: options.webhookSecret });
  }

  private async load(txRef: string): Promise<MockTransaction | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${txRef}`);
    return raw ? (JSON.parse(raw) as MockTransaction) : null;
  }

  private async save(transaction: MockTransaction): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}${transaction.txRef}`, JSON.stringify(transaction), 'EX', TTL_SECONDS);
  }

  override async initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult> {
    await this.save({
      txRef: request.txRef,
      amount: request.amount,
      currency: request.currency,
      status: 'pending',
      method: null,
      returnUrl: request.returnUrl,
      title: request.title,
      description: request.description,
      customerName: `${request.customer.firstName} ${request.customer.lastName}`.trim(),
      createdAt: new Date().toISOString(),
    });
    return { checkoutUrl: `${this.options.webUrl}/dev/checkout/${encodeURIComponent(request.txRef)}` };
  }

  async directPay(request: DirectPayRequest): Promise<DirectPayResult> {
    await this.save({
      txRef: request.txRef,
      amount: request.amount,
      currency: request.currency,
      status: 'pending',
      method: request.method,
      returnUrl: request.returnUrl,
      title: request.title,
      description: request.description,
      customerName: 'Parent',
      createdAt: new Date().toISOString(),
    });
    return {
      sessionId: `mock-${request.txRef}`,
      expiresAt: request.expiresAt.toISOString(),
      alreadySucceeded: false,
      alreadyFailed: false,
    };
  }

  override async verify(txRef: string): Promise<VerifiedTransaction> {
    const transaction = await this.load(txRef);
    if (!transaction) {
      return { txRef, status: 'pending', amount: 0, currency: 'ETB', gatewayReference: null, method: null, fee: null, mode: 'test', raw: null };
    }
    return {
      txRef,
      status: transaction.status === 'success' ? 'succeeded' : transaction.status === 'failed' ? 'failed' : 'pending',
      amount: transaction.amount,
      currency: transaction.currency,
      gatewayReference: transaction.status === 'success' ? `MOCK-${txRef}` : null,
      method: transaction.method,
      fee: transaction.status === 'success' ? Math.round(transaction.amount * 0.03) : null,
      mode: 'test',
      raw: transaction,
    };
  }

  async describe(txRef: string): Promise<MockTransaction | null> {
    return this.load(txRef);
  }

  /** Simulates the payer finishing checkout, then delivers a signed webhook like Chapa does. */
  async complete(txRef: string, outcome: 'success' | 'failed', method: string): Promise<{ returnUrl: string }> {
    const transaction = await this.load(txRef);
    if (!transaction) throw new Error('Unknown mock transaction');
    transaction.status = outcome;
    transaction.method = method;
    await this.save(transaction);

    const body = JSON.stringify({
      event: outcome === 'success' ? 'charge.success' : 'charge.failed/cancelled',
      tx_ref: txRef,
      status: outcome === 'success' ? 'success' : 'failed/cancelled',
      amount: (transaction.amount / 100).toFixed(2),
      currency: transaction.currency,
      reference: outcome === 'success' ? `MOCK-${txRef}` : null,
      payment_method: method,
      mode: 'test',
      created_at: transaction.createdAt,
      updated_at: new Date().toISOString(),
    });
    await fetch(`${this.options.apiUrl}/webhooks/mock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-chapa-signature': hmacSha256Hex(this.options.webhookSecret, body),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    return { returnUrl: transaction.returnUrl };
  }

  override async createSubaccount(request: CreateSubaccountRequest): Promise<{ subaccountId: string }> {
    return { subaccountId: `mock-sub-${request.bankCode}-${request.accountNumber.slice(-4)}` };
  }

  override async listBanks(): Promise<GatewayBank[]> {
    return [
      { id: 946, name: 'Commercial Bank of Ethiopia (CBE)' },
      { id: 855, name: 'telebirr' },
      { id: 128, name: 'CBEBirr' },
      { id: 656, name: 'Awash Bank' },
      { id: 347, name: 'Bank of Abyssinia' },
      { id: 266, name: 'M-Pesa' },
    ];
  }

  override async listTransactions(page: number): Promise<{ transactions: GatewayTransactionSummary[]; hasMore: boolean }> {
    if (page > 1) return { transactions: [], hasMore: false };
    const keys = await this.redis.keys(`${KEY_PREFIX}*`);
    const items = await Promise.all(keys.map((key) => this.redis.get(key)));
    const transactions = items
      .filter((item): item is string => Boolean(item))
      .map((item) => JSON.parse(item) as MockTransaction)
      .filter((item) => item.status === 'success')
      .map((item) => ({
        reference: `MOCK-${item.txRef}`,
        txRef: item.txRef,
        status: 'succeeded',
        amount: item.amount,
        currency: item.currency,
        createdAt: item.createdAt,
      }));
    return { transactions, hasMore: false };
  }
}
