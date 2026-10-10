export const USER_ROLES = ['PLATFORM_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT', 'PARENT'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles that can move or report on money must use TOTP two-factor authentication. */
export const ROLES_REQUIRING_2FA: readonly UserRole[] = ['PLATFORM_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT'];

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'REFUNDED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REVIEW', 'REFUNDED', 'REVERSED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const API_KEY_SCOPES = [
  'students:read',
  'students:write',
  'invoices:read',
  'invoices:write',
  'payments:read',
  'receipts:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const OUTBOUND_WEBHOOK_EVENTS = [
  'invoice.created',
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'receipt.issued',
] as const;
export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];

export const LANGUAGES = ['am', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const OUTBOUND_SIGNATURE_HEADER = 'x-payment-signature';
export const OUTBOUND_TIMESTAMP_HEADER = 'x-payment-timestamp';
