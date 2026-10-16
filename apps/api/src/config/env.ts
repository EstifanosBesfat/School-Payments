import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
loadDotenv({ quiet: true });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().default(4000),
    API_PUBLIC_URL: z.url(),
    WEB_URL: z.url(),
    CORS_ORIGINS: z.string().default(''),
    RUN_WORKERS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    /** Comma-separated peers allowed to set a single-IP X-Forwarded-For. Everyone else is limited by the socket address. */
    TRUSTED_PROXIES: z.string().default(''),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === 32,
        'DATA_ENCRYPTION_KEY must be 32 bytes, base64',
      ),

    RECEIPT_SIGNING_KEY_ID: z.string().min(1),
    RECEIPT_SIGNING_PRIVATE_KEY: z.string().min(1),
    RECEIPT_SIGNING_PUBLIC_KEY: z.string().min(1),
    RECEIPT_ADDITIONAL_PUBLIC_KEYS: optionalString,

    PAYMENT_GATEWAY: z.enum(['chapa', 'mock']).default('mock'),
    CHAPA_BASE_URL: z.url().default('https://api.chapa.co/v1'),
    CHAPA_SECRET_KEY: optionalString,
    CHAPA_WEBHOOK_SECRET: optionalString,
    PLATFORM_FEE_TYPE: z.enum(['percentage', 'flat']).default('percentage'),
    PLATFORM_FEE_VALUE: z.coerce.number().min(0).default(0),

    SMS_PROVIDER: z.enum(['console', 'afromessage', 'geezsms']).default('console'),
    SMS_FALLBACK_PROVIDER: z
      .enum(['console', 'afromessage', 'geezsms', ''])
      .optional()
      .transform((value) => (value ? value : undefined)),
    AFROMESSAGE_TOKEN: optionalString,
    AFROMESSAGE_IDENTIFIER_ID: optionalString,
    AFROMESSAGE_SENDER_NAME: optionalString,
    GEEZSMS_TOKEN: optionalString,
    GEEZSMS_SHORTCODE_ID: optionalString,

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    MAIL_FROM: z.string().default('School Payments <no-reply@example.com>'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_DIR: z.string().default('./storage'),
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().default('receipts'),
    S3_ACCESS_KEY: optionalString,
    S3_SECRET_KEY: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_GATEWAY === 'chapa' && (!env.CHAPA_SECRET_KEY || !env.CHAPA_WEBHOOK_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        message: 'CHAPA_SECRET_KEY and CHAPA_WEBHOOK_SECRET are required for PAYMENT_GATEWAY=chapa',
      });
    }
    if (env.NODE_ENV === 'production' && env.PAYMENT_GATEWAY === 'mock') {
      ctx.addIssue({ code: 'custom', message: 'The mock gateway cannot be used in production' });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.JWT_ACCESS_SECRET === 'change-me-to-a-long-random-string'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'JWT_ACCESS_SECRET is still the example placeholder',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      (env.DATABASE_URL.includes('payment_app_dev_password') ||
        env.DATABASE_URL.includes('payment_owner_dev_password'))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'DATABASE_URL still uses a development database password',
      });
    }
    if (
      env.STORAGE_DRIVER === 's3' &&
      (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY are required for STORAGE_DRIVER=s3',
      });
    }
    const providers = [env.SMS_PROVIDER, env.SMS_FALLBACK_PROVIDER];
    if (providers.includes('afromessage') && !env.AFROMESSAGE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        message: 'AFROMESSAGE_TOKEN is required for the afromessage SMS provider',
      });
    }
    if (providers.includes('geezsms') && !env.GEEZSMS_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        message: 'GEEZSMS_TOKEN is required for the geezsms SMS provider',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
