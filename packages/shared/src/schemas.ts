import { z } from 'zod';
import { API_KEY_SCOPES, LANGUAGES, OUTBOUND_WEBHOOK_EVENTS } from './constants';
import { isEthiopianPhone, normalizeEthiopianPhone } from './phone';

const MAX_SANTIM = 100_000_000_00;

export const santimSchema = z
  .number()
  .int('Amount must be in whole santim')
  .positive('Amount must be greater than zero')
  .max(MAX_SANTIM);

export const phoneSchema = z
  .string()
  .trim()
  .refine(isEthiopianPhone, 'Enter an Ethiopian mobile number, e.g. 0912345678')
  .transform((value) => normalizeEthiopianPhone(value));

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const loginSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(200),
  totpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(500) });

export const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export const createSchoolSchema = z.object({
  name: z.string().trim().min(2).max(200),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, '2-10 letters or digits'),
  contactEmail: z.email(),
  contactPhone: phoneSchema,
  city: z.string().trim().max(100).optional(),
  tin: z.string().trim().max(20).optional(),
  smsSenderName: z.string().trim().max(11).optional(),
  admin: z.object({
    name: z.string().trim().min(2).max(200),
    email: z.email().transform((value) => value.toLowerCase()),
    password: passwordSchema,
  }),
});
export type CreateSchoolInput = z.infer<typeof createSchoolSchema>;

export const schoolSettlementSchema = z.object({
  bankCode: z.number().int().positive(),
  accountNumber: z.string().trim().min(5).max(30),
  accountName: z.string().trim().min(2).max(200),
  businessName: z.string().trim().min(2).max(200),
});
export type SchoolSettlementInput = z.infer<typeof schoolSettlementSchema>;

export const createStaffUserSchema = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.email().transform((value) => value.toLowerCase()),
  password: passwordSchema,
  role: z.enum(['SCHOOL_ADMIN', 'ACCOUNTANT']),
});
export type CreateStaffUserInput = z.infer<typeof createStaffUserSchema>;

export const guardianSchema = z.object({
  name: z.string().trim().min(2).max(200),
  phone: phoneSchema,
  email: z.email().optional(),
  relationship: z.string().trim().max(50).optional(),
  language: z.enum(LANGUAGES).default('am'),
  isPrimary: z.boolean().default(false),
});
export type GuardianInput = z.infer<typeof guardianSchema>;

export const createStudentSchema = z.object({
  code: z.string().trim().min(1).max(50),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  grade: z.string().trim().min(1).max(20),
  section: z.string().trim().max(20).optional(),
  guardians: z.array(guardianSchema).min(1).max(5),
});
export type CreateStudentInput = z.infer<typeof createStudentSchema>;

export const importStudentsSchema = z.object({
  students: z.array(createStudentSchema).min(1).max(2000),
});

export const createFeeItemSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(500).optional(),
  amount: santimSchema,
});
export type CreateFeeItemInput = z.infer<typeof createFeeItemSchema>;

export const invoiceLineSchema = z.object({
  feeItemId: z.string().optional(),
  description: z.string().trim().min(1).max(200),
  amount: santimSchema,
});

export const createInvoiceSchema = z.object({
  studentId: z.string().min(1),
  term: z.string().trim().max(50).optional(),
  dueDate: isoDateSchema,
  lines: z.array(invoiceLineSchema).min(1).max(50),
  notify: z.boolean().default(true),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const bulkInvoiceSchema = z.object({
  grade: z.string().trim().min(1).max(20),
  section: z.string().trim().max(20).optional(),
  term: z.string().trim().max(50).optional(),
  dueDate: isoDateSchema,
  feeItemIds: z.array(z.string().min(1)).min(1).max(20),
  notify: z.boolean().default(true),
});
export type BulkInvoiceInput = z.infer<typeof bulkInvoiceSchema>;

export const startPaymentSchema = z.object({
  payerName: z.string().trim().min(2).max(200),
  payerPhone: phoneSchema,
  payerEmail: z.email().optional(),
});
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const createWebhookEndpointSchema = z.object({
  url: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://localhost'), {
    message: 'Webhook URLs must use HTTPS',
  }),
  events: z.array(z.enum(OUTBOUND_WEBHOOK_EVENTS)).min(1),
});
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

export const receiptLookupSchema = z.object({
  receiptNo: z.string().trim().min(3).max(60),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-F]{4}-?[0-9A-F]{4}$/, 'Enter the 8-character code from the receipt'),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
