export const QUEUES = {
  webhooks: 'gateway-webhooks',
  payments: 'payment-verification',
  receipts: 'receipts',
  notifications: 'notifications',
  outbound: 'outbound-webhooks',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  processWebhookEvent: 'process-webhook-event',
  verifyPayment: 'verify-payment',
  issueReceipt: 'issue-receipt',
  renderReceiptPdf: 'render-receipt-pdf',
  sendSms: 'send-sms',
  sendEmail: 'send-email',
  deliverWebhook: 'deliver-webhook',
  reconcile: 'reconcile',
  sweepPendingPayments: 'sweep-pending-payments',
  sendReminders: 'send-reminders',
  cleanup: 'cleanup',
} as const;

export interface ProcessWebhookEventJob {
  webhookEventId: string;
}

export interface VerifyPaymentJob {
  txRef: string;
  reason: 'webhook' | 'callback' | 'sweep' | 'manual' | 'return';
}

export interface IssueReceiptJob {
  paymentId: string;
}

export interface RenderReceiptPdfJob {
  receiptId: string;
}

export interface SendSmsJob {
  smsMessageId: string;
}

export interface SendEmailJob {
  emailMessageId: string;
  html: string;
  text: string;
  attachments?: { filename: string; storageKey: string; contentType: string }[];
}

export interface DeliverWebhookJob {
  deliveryId: string;
}
