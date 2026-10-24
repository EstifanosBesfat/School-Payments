import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createPrismaClient, type PrismaClient } from '@payment/db';
import { verifyReceiptSignature } from '@payment/shared';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
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

    const payToken = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.body.id }, select: { payToken: true, billRef: true, number: true } });
    expect(payToken.billRef).toBe(payToken.number);
    const view = await http.get(`/pay/${payToken.payToken}`);
    expect(view.status).toBe(200);
    expect(view.body.invoice.balance).toBe(350_000);
    expect(view.body.acceptingPayments).toBe(true);

    const start = await http.post(`/pay/${payToken.payToken}/start`).send({ payerName: 'Kebede Alemu', payerPhone: '0911223344', payerEmail: 'parent@e2e.test', method: 'telebirr' });
    expect(start.status).toBe(201);
    const { kind, txRef, checkoutUrl } = start.body as { kind: string; txRef: string; checkoutUrl: string };
    expect(kind).toBe('redirect');
    expect(checkoutUrl).toContain(txRef);

    const unsigned = await http.post('/webhooks/mock').set('Content-Type', 'application/json').send({ tx_ref: txRef, status: 'success' });
    expect(unsigned.status).toBe(401);

    const pendingBeforePay = await http.get(`/pay/${payToken.payToken}/status`).query({ tx: txRef });
    expect(pendingBeforePay.body.payment.status).toBe('PENDING');

    const complete = await http.post(`/dev/mock-gateway/${txRef}/complete`).send({ outcome: 'success', method: 'telebirr' });
    expect(complete.status).toBeLessThan(300);

    const status = await waitFor(async () => {
      const response = await http.get(`/pay/${payToken.payToken}/status`).query({ tx: txRef });
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

    const issue = await owner.reconciliationIssue.create({
      data: { schoolId, kind: 'amount_mismatch', txRef: `RECON-${suffix}`, details: { amount: 100 } },
    });
    const hiddenIssue = await appRole.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.school_id', 'some-other-school', true)`;
      return tx.reconciliationIssue.findUnique({ where: { id: issue.id } });
    });
    expect(hiddenIssue).toBeNull();
    const visibleIssue = await appRole.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.school_id', ${schoolId}, true)`;
      return tx.reconciliationIssue.findUnique({ where: { id: issue.id } });
    });
    expect(visibleIssue?.kind).toBe('amount_mismatch');

    const auth = { Authorization: `Bearer ${accessToken}` };
    const listed = await http.get('/reconciliation/issues').set(auth).query({ status: 'OPEN' });
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((item: { id: string }) => item.id === issue.id)).toBe(true);
    const otherSchool = await owner.school.create({
      data: { name: `Other ${suffix}`, code: `OTH${suffix}`, status: 'ACTIVE', contactEmail: 'other@e2e.test', contactPhone: '+251911000002' },
    });
    const foreign = await owner.reconciliationIssue.create({
      data: { schoolId: otherSchool.id, kind: 'status_mismatch', txRef: `RECON-OTH-${suffix}`, details: { amount: 50 } },
    });
    const stillOwn = await http.get('/reconciliation/issues').set(auth).query({ status: 'OPEN' });
    expect(stillOwn.body.items.some((item: { id: string }) => item.id === foreign.id)).toBe(false);
    const resolved = await http.post(`/reconciliation/issues/${issue.id}/resolve`).set(auth).send({ note: 'Checked against the gateway export' });
    expect(resolved.status).toBe(201);
    expect(resolved.body.status).toBe('RESOLVED');
    const cannotRun = await http.post('/reconciliation/run').set(auth);
    expect(cannotRun.status).toBe(403);
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

  it('addresses students by code on /v1 and signs outbound webhooks', async () => {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const key = await http.post('/integrations/api-keys').set(auth).send({
      name: 'SIS integration',
      scopes: ['students:read', 'invoices:read', 'invoices:write', 'payments:read', 'receipts:read'],
    });
    expect(key.status).toBe(201);
    const apiKey = key.body.key as string;

    const balance = await http.get(`/v1/students/S-${suffix}/balance`).set('X-Api-Key', apiKey);
    expect(balance.status).toBe(200);
    expect(balance.body.student.code).toBe(`S-${suffix}`);
    expect(balance.body.currency).toBe('ETB');
    expect(balance.body.balance).toBe(0);

    const narrow = await http.post('/integrations/api-keys').set(auth).send({ name: 'Invoices only', scopes: ['invoices:read'] });
    expect(narrow.status).toBe(201);
    const missingScope = await http.get(`/v1/students/S-${suffix}/balance`).set('X-Api-Key', narrow.body.key);
    expect(missingScope.status).toBe(403);

    const idemKey = `e2e-v1-invoice-${suffix}`;
    const body = {
      studentCode: `S-${suffix}`,
      term: 'Term 1',
      dueDate: '2026-12-31',
      lines: [{ description: 'Books', amount: 12_500 }],
      notify: false,
    };
    const created = await http.post('/v1/invoices').set('X-Api-Key', apiKey).set('Idempotency-Key', idemKey).send(body);
    expect(created.status).toBe(201);
    expect(created.body.balance).toBe(12_500);
    expect(created.body.payUrl).toContain('/pay/');
    const replay = await http.post('/v1/invoices').set('X-Api-Key', apiKey).set('Idempotency-Key', idemKey).send(body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.number).toBe(created.body.number);

    const invoice = await http.get(`/v1/invoices/${created.body.number}`).set('X-Api-Key', apiKey);
    expect(invoice.status).toBe(200);
    expect(invoice.body.student.code).toBe(`S-${suffix}`);

    const paymentRow = await owner.payment.findFirstOrThrow({
      where: { schoolId, status: 'SUCCEEDED' },
      include: { receipt: true },
    });
    const payment = await http.get(`/v1/payments/${paymentRow.txRef}`).set('X-Api-Key', apiKey);
    expect(payment.status).toBe(200);
    expect(payment.body.status).toBe('SUCCEEDED');
    expect(payment.body.receipt.receiptNo).toBe(paymentRow.receipt?.receiptNo);

    const receipt = await http.get(`/v1/receipts/${paymentRow.receipt?.receiptNo}`).set('X-Api-Key', apiKey);
    expect(receipt.status).toBe(200);
    const keys = await http.get('/.well-known/receipt-keys.json');
    const verified = await verifyReceiptSignature(keys.body.keys, { payload: receipt.body.payload, signature: receipt.body.signature });
    expect(verified.valid).toBe(true);
    expect(receipt.body.qr).toContain('#');

    const received: { raw: string; signature: string; timestamp: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          raw: Buffer.concat(chunks).toString('utf8'),
          signature: String(req.headers['x-payment-signature'] ?? ''),
          timestamp: String(req.headers['x-payment-timestamp'] ?? ''),
        });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const endpoint = await http.post('/integrations/webhooks').set(auth).send({
        url: `http://localhost:${port}/hooks`,
        events: ['invoice.created'],
      });
      expect(endpoint.status).toBe(201);
      const ping = await http.post(`/integrations/webhooks/${endpoint.body.id}/ping`).set(auth);
      expect(ping.status).toBe(201);
      const event = await waitFor(async () => received[0]);
      const expected = createHmac('sha256', endpoint.body.secret as string)
        .update(`${event.timestamp}.${event.raw}`)
        .digest('hex');
      expect(event.signature).toBe(expected);
      expect(JSON.parse(event.raw).event).toBe('ping');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('keeps one pending payment per invoice and freezes the billing id', async () => {
    const student = await owner.student.create({
      data: { schoolId, code: `BILL-${suffix}`, firstName: 'Sara', lastName: 'Bekele', grade: '6' },
    });
    const billRef = `${schoolCode}-BILL-${suffix}`;
    const invoice = await owner.invoice.create({
      data: {
        schoolId,
        studentId: student.id,
        number: billRef,
        billRef,
        totalAmount: 10_000,
        dueDate: new Date('2026-12-31'),
        payToken: `pay-${suffix}-bill`,
      },
    });
    await expect(owner.$executeRaw`UPDATE "Invoice" SET "billRef" = ${'changed'} WHERE id = ${invoice.id}`).rejects.toThrow(/immutable|billRef/);

    await owner.payment.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        txRef: `PEND-A-${suffix}`,
        gateway: 'arifpay',
        amount: 10_000,
        payerName: 'Sara Bekele',
        payerPhone: '+251911000099',
        status: 'PENDING',
        gatewaySessionId: `SESS-A-${suffix}`,
        payerMethod: 'telebirr',
      },
    });
    await expect(
      owner.payment.create({
        data: {
          schoolId,
          invoiceId: invoice.id,
          txRef: `PEND-B-${suffix}`,
          gateway: 'arifpay',
          amount: 10_000,
          payerName: 'Sara Bekele',
          payerPhone: '+251911000099',
          status: 'PENDING',
        },
      }),
    ).rejects.toThrow(/payment_one_pending_per_invoice|Unique constraint/i);

    await owner.payment.update({ where: { txRef: `PEND-A-${suffix}` }, data: { status: 'FAILED' } });
    const second = await owner.payment.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        txRef: `PEND-B-${suffix}`,
        gateway: 'arifpay',
        amount: 10_000,
        payerName: 'Sara Bekele',
        payerPhone: '+251911000099',
        status: 'PENDING',
        payerMethod: 'telebirr',
      },
    });
    expect(second.gatewaySessionId).toBeNull();
    const alsoWithoutSession = await owner.payment.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        txRef: `PEND-C-${suffix}`,
        gateway: 'mock',
        amount: 10_000,
        payerName: 'Sara Bekele',
        payerPhone: '+251911000099',
        status: 'FAILED',
      },
    });
    expect(alsoWithoutSession.gatewaySessionId).toBeNull();

    await expect(
      owner.payment.create({
        data: {
          schoolId,
          invoiceId: invoice.id,
          txRef: `PEND-D-${suffix}`,
          gateway: 'mock',
          amount: 10_000,
          payerName: 'Sara Bekele',
          payerPhone: '+251911000099',
          status: 'FAILED',
          gatewaySessionId: `SESS-A-${suffix}`,
        },
      }),
    ).rejects.toThrow(/gatewaySessionId|Unique constraint/i);

    await owner.webhookEvent.create({
      data: {
        gateway: 'arifpay',
        eventKey: `evt-${suffix}`,
        eventType: 'SUCCESS',
        txRef: `PEND-B-${suffix}`,
        sessionId: `SESS-B-${suffix}`,
        signatureValid: true,
        payload: { nonce: `PEND-B-${suffix}` },
      },
    });

    const hidden = await appRole.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.school_id', 'some-other-school', true)`;
      return tx.payment.findUnique({ where: { txRef: `PEND-B-${suffix}` }, select: { gatewaySessionId: true, payerMethod: true } });
    });
    expect(hidden).toBeNull();
    const own = await appRole.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.school_id', ${schoolId}, true)`;
      return tx.payment.findUnique({ where: { txRef: `PEND-B-${suffix}` }, select: { payerMethod: true } });
    });
    expect(own?.payerMethod).toBe('telebirr');
  });
});
