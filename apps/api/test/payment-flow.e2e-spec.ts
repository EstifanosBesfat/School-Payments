import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPrismaClient, type PrismaClient } from '@payment/db';
import { verifyReceiptSignature } from '@payment/shared';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

const E2E_PORT = 4100;
process.env.API_PORT = String(E2E_PORT);
process.env.API_PUBLIC_URL = `http://localhost:${E2E_PORT}`;
process.env.PAYMENT_GATEWAY = 'mock';
process.env.SMS_PROVIDER = 'console';
process.env.RUN_WORKERS = 'true';

/* eslint-disable @typescript-eslint/no-require-imports */
const { loadEnv } = require('../src/config/env') as typeof import('../src/config/env');
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { SecretBox } = require('../src/common/crypto.util') as typeof import('../src/common/crypto.util');
const { hashPassword } = require('../src/auth/password') as typeof import('../src/auth/password');
const totp = require('../src/auth/totp') as typeof import('../src/auth/totp');

const env = loadEnv();
const suffix = randomBytes(3).toString('hex').toUpperCase();
const schoolCode = `E2E${suffix}`;
const adminEmail = `admin-${suffix.toLowerCase()}@e2e.test`;
const password = 'E2e-password-2026';
const totpSecret = totp.base32Encode(randomBytes(20));

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('Payment flow (mock gateway, real Postgres + Redis)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let appRole: PrismaClient;
  let http: ReturnType<typeof request>;
  let schoolId: string;
  let accessToken: string;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL });
    appRole = createPrismaClient({ connectionString: env.DATABASE_URL });
    const box = new SecretBox(env.DATA_ENCRYPTION_KEY);
    const school = await owner.school.create({
      data: { name: `E2E Academy ${suffix}`, code: schoolCode, status: 'ACTIVE', contactEmail: 'e2e@e2e.test', contactPhone: '+251911000001' },
    });
    schoolId = school.id;
    await owner.user.create({
      data: {
        email: adminEmail,
        name: 'E2E Admin',
        role: 'SCHOOL_ADMIN',
        schoolId,
        passwordHash: await hashPassword(password),
        totpEnabled: true,
        totpSecretEncrypted: box.encrypt(totpSecret),
      },
    });

    const nest = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['error', 'warn'] });
    await nest.listen(E2E_PORT);
    app = nest;
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await appRole?.$disconnect();
  });

  it('requires two-factor codes for staff and rejects bad ones', async () => {
    const missing = await http.post('/auth/login').send({ email: adminEmail, password });
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('TOTP_REQUIRED');
    const wrong = await http.post('/auth/login').send({ email: adminEmail, password, totpCode: '000000' });
    expect(wrong.status).toBe(401);

    const code = totp.hotp(totp.base32Decode(totpSecret), totp.currentStep(Date.now()));
    const ok = await http.post('/auth/login').send({ email: adminEmail, password, totpCode: code });
    accessToken = ok.body.accessToken;
    expect(ok.status).toBe(200);
    expect(accessToken).toBeTruthy();
  });

  it('collects a payment, settles it from the verified webhook and issues a signed receipt', async () => {
    const auth = { Authorization: `Bearer ${accessToken}` };

    const fee = await http.post('/fee-items').set(auth).send({ name: `Tuition ${suffix}`, amount: 350_000 });
    expect(fee.status).toBe(201);
    const student = await http
      .post('/students')
      .set(auth)
      .send({ code: `S-${suffix}`, firstName: 'Abebe', lastName: 'Kebede', grade: '5', section: 'A', guardians: [{ name: 'Kebede Alemu', phone: '0911223344', language: 'am' }] });
    expect(student.status).toBe(201);

    const idemKey = `e2e-invoice-${suffix}`;
    const invoice = await http
      .post('/invoices')
      .set(auth)
      .set('Idempotency-Key', idemKey)
      .send({ studentId: student.body.id, term: 'Term 1', dueDate: '2026-12-31', lines: [{ feeItemId: fee.body.id, description: 'Tuition', amount: 350_000 }], notify: true });
    expect(invoice.status).toBe(201);
    const replay = await http
      .post('/invoices')
      .set(auth)
      .set('Idempotency-Key', idemKey)
      .send({ studentId: student.body.id, term: 'Term 1', dueDate: '2026-12-31', lines: [{ feeItemId: fee.body.id, description: 'Tuition', amount: 350_000 }], notify: true });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(invoice.body.id);

    const payToken = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.body.id }, select: { payToken: true } }).then((row) => row.payToken);
    const view = await http.get(`/pay/${payToken}`);
    expect(view.status).toBe(200);
    expect(view.body.invoice.balance).toBe(350_000);
    expect(view.body.acceptingPayments).toBe(true);

    const start = await http.post(`/pay/${payToken}/start`).send({ payerName: 'Kebede Alemu', payerPhone: '0911223344', payerEmail: 'parent@e2e.test' });
    expect(start.status).toBe(201);
    const { txRef, checkoutUrl } = start.body as { txRef: string; checkoutUrl: string };
    expect(checkoutUrl).toContain(txRef);

    const unsigned = await http.post('/webhooks/mock').set('Content-Type', 'application/json').send({ tx_ref: txRef, status: 'success' });
    expect(unsigned.status).toBe(401);

    const pendingBeforePay = await http.get(`/pay/${payToken}/status`).query({ tx: txRef });
    expect(pendingBeforePay.body.payment.status).toBe('PENDING');

    const complete = await http.post(`/dev/mock-gateway/${txRef}/complete`).send({ outcome: 'success', method: 'telebirr' });
    expect(complete.status).toBeLessThan(300);

    const status = await waitFor(async () => {
      const response = await http.get(`/pay/${payToken}/status`).query({ tx: txRef });
      return response.body.receipt?.pdfReady ? response.body : null;
    });
    expect(status.payment.status).toBe('SUCCEEDED');
    expect(status.invoiceStatus).toBe('PAID');

    const lookup = await http.get('/receipts/lookup').query({ receiptNo: status.receipt.receiptNo, code: status.receipt.verificationCode });
    expect(lookup.status).toBe(200);
    expect(lookup.body.signatureValid).toBe(true);
    expect(lookup.body.payload.total).toBe(350_000);
    expect(lookup.body.payload.payer.phone).toBe('+2519****3344');

    const keys = await http.get('/.well-known/receipt-keys.json');
    const offline = await verifyReceiptSignature(keys.body.keys, { payload: lookup.body.payload, signature: lookup.body.signature });
    expect(offline.valid).toBe(true);

    const wrongCode = await http.get('/receipts/lookup').query({ receiptNo: status.receipt.receiptNo, code: '0000-0000' });
    expect(wrongCode.status).toBe(404);

    const pdf = await http.get(`/receipts/${status.receipt.id}/pdf`).set(auth).responseType('blob');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const balances = await http.get('/school/ledger/balances').set(auth);
    expect(balances.body.STUDENT_RECEIVABLE).toBe(0);
    expect(balances.body.FEE_REVENUE).toBe(-350_000);
    const payment = await owner.payment.findUniqueOrThrow({ where: { txRef } });
    expect(balances.body.GATEWAY_CLEARING).toBe(350_000 - (payment.gatewayFee ?? 0) - (payment.platformFee ?? 0));

    const replayedWebhookOutcome = await http.post(`/payments/${payment.id}/verify`).set(auth);
    expect(replayedWebhookOutcome.body.outcome).toBe('already_final');
    expect(await owner.receipt.count({ where: { paymentId: payment.id } })).toBe(1);

    const chain = await http.post('/receipts/chain/verify').set(auth);
    expect(chain.body.valid).toBe(true);
  });

  it('enforces append-only money records in the database', async () => {
    await expect(owner.$executeRawUnsafe(`UPDATE "LedgerEntry" SET amount = amount + 1 WHERE "schoolId" = '${schoolId}'`)).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "schoolId" = '${schoolId}'`)).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe(`UPDATE "Receipt" SET "receiptNo" = 'FORGED' WHERE "schoolId" = '${schoolId}'`)).rejects.toThrow(/immutable/);
    await expect(owner.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "schoolId" = '${schoolId}'`)).rejects.toThrow(/append-only/);
  });

  it('isolates schools with row-level security for the application role', async () => {
    const visible = await appRole.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.school_id', 'some-other-school', true)`;
      return tx.payment.count({ where: { schoolId } });
    });
    expect(visible).toBe(0);
    const own = await appRole.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.school_id', ${schoolId}, true)`;
      return tx.payment.count({ where: { schoolId } });
    });
    expect(own).toBe(1);
  });

  it('rejects API keys without the needed scope', async () => {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const key = await http.post('/integrations/api-keys').set(auth).send({ name: 'Read-only SIS', scopes: ['students:read'] });
    expect(key.status).toBe(201);
    const allowed = await http.get('/students').set('X-Api-Key', key.body.key);
    expect(allowed.status).toBe(200);
    const denied = await http.get('/invoices').set('X-Api-Key', key.body.key);
    expect(denied.status).toBe(403);
  });
});
