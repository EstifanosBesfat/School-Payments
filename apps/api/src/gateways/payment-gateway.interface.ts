export interface GatewayCustomer {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
}

export interface SplitConfig {
  subaccountId: string;
  type: 'percentage' | 'flat';
  /** percentage: fraction (0.02 = 2%); flat: santim. */
  value: number;
}

export interface InitializePaymentRequest {
  txRef: string;
  amount: number;
  currency: 'ETB';
  customer: GatewayCustomer;
  callbackUrl: string;
  returnUrl: string;
  title: string;
  description: string;
  split?: SplitConfig;
  lineItems?: { label: string; value: string }[];
}

export interface InitializePaymentResult {
  checkoutUrl: string;
}

export type PayerRail = 'telebirr' | 'cbe_birr';

export interface DirectPayBeneficiary {
  accountNumber: string;
  bank: string;
  /** Santim. The adapter converts this to ETB at the request boundary. */
  amount: number;
}

export interface DirectPayRequest {
  txRef: string;
  amount: number;
  currency: 'ETB';
  method: PayerRail;
  /** E.164. Converted to 251… inside the adapter. */
  phone: string;
  email: string;
  notifyUrl: string;
  returnUrl: string;
  title: string;
  description: string;
  expiresAt: Date;
  beneficiary?: DirectPayBeneficiary;
}

export interface DirectPayResult {
  sessionId: string;
  expiresAt: string;
  alreadySucceeded: boolean;
  alreadyFailed: boolean;
}

export type VerifiedStatus = 'succeeded' | 'failed' | 'pending' | 'refunded' | 'reversed';

/** Payer details as the provider recorded them, including a relative who paid on the hosted checkout. */
export interface VerifiedPayer {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface VerifiedTransaction {
  txRef: string;
  status: VerifiedStatus;
  amount: number;
  currency: string;
  gatewayReference: string | null;
  method: string | null;
  fee: number | null;
  mode: 'test' | 'live' | null;
  payer?: VerifiedPayer;
  raw: unknown;
}

export interface ParsedWebhook {
  signatureValid: boolean;
  /** Stable key used to deduplicate redeliveries of the same event. */
  eventKey: string;
  eventType: string;
  txRef: string | null;
  sessionId?: string | null;
  payload: unknown;
}

export interface CreateSubaccountRequest {
  businessName: string;
  accountName: string;
  bankCode: number;
  accountNumber: string;
  splitType: 'percentage' | 'flat';
  splitValue: number;
}

export interface GatewayBank {
  id: number;
  name: string;
}

export interface GatewayTransactionSummary {
  reference: string;
  txRef: string | null;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
}

/**
 * Every payment provider (Chapa, SantimPay, ArifPay, direct telebirr) is an adapter behind this
 * interface. Business code never talks to a provider directly.
 */
export interface PaymentGateway {
  readonly name: string;
  initialize(request: InitializePaymentRequest): Promise<InitializePaymentResult>;
  /** Phone prompt for a single rail. The parent never leaves our site. */
  directPay?(request: DirectPayRequest): Promise<DirectPayResult>;
  /** Authoritative server-to-server status lookup. The only thing allowed to confirm a payment. */
  verify(txRef: string): Promise<VerifiedTransaction>;
  /** Verify when the provider keys transactions by its own session id rather than our nonce. */
  verifySession?(sessionId: string, txRef: string): Promise<VerifiedTransaction>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook;
  createSubaccount(request: CreateSubaccountRequest): Promise<{ subaccountId: string }>;
  listBanks(): Promise<GatewayBank[]>;
  listTransactions(page: number): Promise<{ transactions: GatewayTransactionSummary[]; hasMore: boolean }>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
