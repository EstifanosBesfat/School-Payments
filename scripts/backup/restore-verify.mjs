import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeRestoreTarget,
  createBackup,
  loadEnvFile,
  parseDatabaseUrl,
  restoreDump,
  spawnText,
} from './lib.mjs';

const SYNTHETIC_PHONE = '+251900000000';
const SCHOOL_ID = 'sch_backup_synth';
const AMOUNT = 150_000;

function hideSensitive(text, secrets = []) {
  let output = text.split(SYNTHETIC_PHONE).join('[redacted-phone]');
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output;
}

export function disposableContainerName() {
  return `payment-backup-verify-${randomBytes(4).toString('hex')}`;
}

export function assertOwnedContainer(name) {
  if (!/^payment-backup-verify-[a-f0-9]{8}$/.test(name)) {
    throw new Error('Refusing to remove a container this verification did not create.');
  }
}

function databaseUrl(password, port, database) {
  return `postgresql://payment_owner:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

function publishedPort(text) {
  const match = text.match(/:(\d+)\s*$/m);
  if (!match) throw new Error('Docker did not publish a port for the isolated database.');
  return match[1];
}

async function psql(container, database, sql, secrets = []) {
  const result = await spawnText(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-U',
      'payment_owner',
      '-d',
      database,
      '-t',
      '-A',
    ],
    {
      input: sql,
      secrets,
    },
  );
  if (result.code !== 0)
    throw new Error(
      hideSensitive(`psql failed (exit ${result.code}). ${result.stderr}`.trim(), secrets),
    );
  return result.stdout.trim();
}

function syntheticReceipt(shared) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const paidAt = '2026-10-11T06:00:00.000Z';
  const payload = {
    v: shared.RECEIPT_PAYLOAD_VERSION,
    kid: 'backup-verify',
    receiptNo: 'SYNTH-R-0000001',
    school: { id: SCHOOL_ID, name: 'Synthetic Academy', code: 'SYNTH' },
    student: { name: 'Synthetic Student', code: 'SYNTH-001', grade: '4' },
    payer: { name: 'Synthetic Payer', phone: SYNTHETIC_PHONE },
    invoiceNo: 'SYNTH-2026-000001',
    items: [{ label: 'Synthetic tuition', amount: AMOUNT }],
    total: AMOUNT,
    currency: 'ETB',
    method: 'telebirr',
    gateway: 'mock',
    gatewayRef: 'gw_backup_synth',
    txRef: 'SYNTH-TX-0001',
    paidAt,
    issuedAt: paidAt,
    prevHash: null,
  };
  const canonical = shared.canonicalReceiptPayload(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url');
  const publicKeyRaw = publicKey.export({ format: 'jwk' }).x;
  return { payload, signature, publicKeyRaw, paidAt };
}

function insertSql(receipt, payloadHash) {
  const payloadJson = JSON.stringify(receipt.payload);
  const paidAt = receipt.paidAt;
  return `
INSERT INTO "School" (id, name, code, status, "contactEmail", "contactPhone", "receiptSeq", "invoiceSeq", "lastReceiptHash", "updatedAt")
VALUES ('${SCHOOL_ID}', 'Synthetic Academy', 'SYNTH', 'ACTIVE', 'synthetic@example.test', '${SYNTHETIC_PHONE}', 1, 1, '${payloadHash}', '${paidAt}');
INSERT INTO "Student" (id, "schoolId", code, "firstName", "lastName", grade, "updatedAt")
VALUES ('stu_backup_synth', '${SCHOOL_ID}', 'SYNTH-001', 'Synthetic', 'Student', '4', '${paidAt}');
INSERT INTO "Invoice" (id, "schoolId", "studentId", number, status, "totalAmount", "paidAmount", "dueDate", "payToken", "issuedAt", "paidAt", "updatedAt")
VALUES ('inv_backup_synth', '${SCHOOL_ID}', 'stu_backup_synth', 'SYNTH-2026-000001', 'PAID', ${AMOUNT}, ${AMOUNT}, '2026-10-11', 'tok_backup_synth', '${paidAt}', '${paidAt}', '${paidAt}');
INSERT INTO "InvoiceLine" (id, "schoolId", "invoiceId", description, amount, position)
VALUES ('lin_backup_synth', '${SCHOOL_ID}', 'inv_backup_synth', 'Synthetic tuition', ${AMOUNT}, 1);
INSERT INTO "Payment" (id, "schoolId", "invoiceId", "txRef", gateway, status, amount, "payerName", "payerPhone", method, "gatewayReference", "verifiedAt", "succeededAt", "updatedAt")
VALUES ('pay_backup_synth', '${SCHOOL_ID}', 'inv_backup_synth', 'SYNTH-TX-0001', 'mock', 'SUCCEEDED', ${AMOUNT}, 'Synthetic Payer', '${SYNTHETIC_PHONE}', 'telebirr', 'gw_backup_synth', '${paidAt}', '${paidAt}', '${paidAt}');
INSERT INTO "LedgerEntry" (id, "schoolId", "transactionId", "paymentId", "invoiceId", account, direction, amount, memo)
VALUES
  ('led_backup_debit', '${SCHOOL_ID}', 'txn_backup_synth', 'pay_backup_synth', 'inv_backup_synth', 'GATEWAY_CLEARING', 'DEBIT', ${AMOUNT}, 'Synthetic clearing'),
  ('led_backup_credit', '${SCHOOL_ID}', 'txn_backup_synth', 'pay_backup_synth', 'inv_backup_synth', 'FEE_REVENUE', 'CREDIT', ${AMOUNT}, 'Synthetic tuition');
INSERT INTO "Receipt" (id, "schoolId", "paymentId", "invoiceId", "receiptNo", sequence, payload, "payloadHash", "prevHash", signature, "keyId", "issuedAt")
VALUES ('rcp_backup_synth', '${SCHOOL_ID}', 'pay_backup_synth', 'inv_backup_synth', 'SYNTH-R-0000001', 1, $payload$${payloadJson}$payload$::jsonb, '${payloadHash}', NULL, '${receipt.signature}', 'backup-verify', '${paidAt}');
INSERT INTO "AuditLog" (id, "schoolId", "actorType", action, "entityType", "entityId", metadata)
VALUES ('aud_backup_synth', '${SCHOOL_ID}', 'system', 'payment.settled', 'Payment', 'pay_backup_synth', '{"source":"backup-verify"}'::jsonb);
INSERT INTO "WebhookEvent" (id, gateway, "eventKey", "eventType", "txRef", "signatureValid", payload, status)
VALUES ('wh_backup_synth', 'mock', 'evt_backup_synth', 'charge.success', 'SYNTH-TX-0001', true, '{"synthetic":true}'::jsonb, 'PROCESSED');
`;
}

const REPORT_SQL = `
SELECT json_build_object(
  'migrations', (SELECT count(*)::int FROM "_prisma_migrations"),
  'schoolId', s.id,
  'schoolCode', s.code,
  'lastReceiptHash', s."lastReceiptHash",
  'studentSchoolId', st."schoolId",
  'invoiceSchoolId', i."schoolId",
  'invoiceStatus', i.status,
  'invoiceTotal', i."totalAmount",
  'invoicePaid', i."paidAmount",
  'paymentSchoolId', p."schoolId",
  'paymentStatus', p.status,
  'paymentAmount', p.amount,
  'paymentTxRef', p."txRef",
  'debit', (SELECT amount FROM "LedgerEntry" WHERE id = 'led_backup_debit'),
  'debitAccount', (SELECT account FROM "LedgerEntry" WHERE id = 'led_backup_debit'),
  'credit', (SELECT amount FROM "LedgerEntry" WHERE id = 'led_backup_credit'),
  'creditAccount', (SELECT account FROM "LedgerEntry" WHERE id = 'led_backup_credit'),
  'ledgerSchool', (SELECT count(*)::int FROM "LedgerEntry" WHERE "schoolId" = s.id),
  'receiptNo', r."receiptNo",
  'receiptSchoolId', r."schoolId",
  'sequence', r.sequence,
  'prevHash', r."prevHash",
  'payloadHash', r."payloadHash",
  'signature', r.signature,
  'keyId', r."keyId",
  'payload', r.payload,
  'auditSchoolId', a."schoolId",
  'auditAction', a.action,
  'webhookKey', w."eventKey",
  'webhookTxRef', w."txRef",
  'webhookValid', w."signatureValid"
)
FROM "School" s
JOIN "Student" st ON st."schoolId" = s.id AND st.code = 'SYNTH-001'
JOIN "Invoice" i ON i."schoolId" = s.id AND i.number = 'SYNTH-2026-000001'
JOIN "Payment" p ON p."invoiceId" = i.id
JOIN "Receipt" r ON r."paymentId" = p.id
JOIN "AuditLog" a ON a."entityId" = p.id
JOIN "WebhookEvent" w ON w."txRef" = p."txRef";
`;

export async function verifyRestoredRecords(report, expectedHash, publicKeyRaw, shared) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  expect(report.migrations > 0, 'schema migrations were not restored');
  expect(report.schoolId === SCHOOL_ID, 'school id changed');
  expect(report.schoolCode === 'SYNTH', 'school code changed');
  expect(report.studentSchoolId === SCHOOL_ID, 'student is not linked to the school');
  expect(report.invoiceSchoolId === SCHOOL_ID, 'invoice is not linked to the school');
  expect(report.paymentSchoolId === SCHOOL_ID, 'payment is not linked to the school');
  expect(report.receiptSchoolId === SCHOOL_ID, 'receipt is not linked to the school');
  expect(report.auditSchoolId === SCHOOL_ID, 'audit log is not linked to the school');
  expect(report.ledgerSchool === 2, 'ledger entries are missing');
  expect(report.invoiceStatus === 'PAID', 'invoice status changed');
  expect(report.invoiceTotal === AMOUNT && report.invoicePaid === AMOUNT, 'invoice amount changed');
  expect(
    report.paymentStatus === 'SUCCEEDED' && report.paymentAmount === AMOUNT,
    'payment amount or status changed',
  );
  expect(report.paymentTxRef === 'SYNTH-TX-0001', 'payment txRef changed');
  expect(
    report.debit === AMOUNT && report.debitAccount === 'GATEWAY_CLEARING',
    'debit ledger entry changed',
  );
  expect(
    report.credit === AMOUNT && report.creditAccount === 'FEE_REVENUE',
    'credit ledger entry changed',
  );
  expect(report.receiptNo === 'SYNTH-R-0000001', 'receipt number changed');
  expect(report.sequence === 1 && report.prevHash === null, 'receipt hash chain head changed');
  expect(report.payloadHash === expectedHash, 'receipt payload hash changed');
  expect(report.lastReceiptHash === expectedHash, 'school chain head does not match the receipt');
  expect(report.keyId === 'backup-verify', 'receipt key id changed');
  expect(report.auditAction === 'payment.settled', 'audit action changed');
  expect(
    report.webhookKey === 'evt_backup_synth' &&
      report.webhookTxRef === 'SYNTH-TX-0001' &&
      report.webhookValid === true,
    'webhook delivery record changed',
  );
  const verified = await shared.verifyReceiptSignature(
    { 'backup-verify': publicKeyRaw },
    { payload: report.payload, signature: report.signature },
  );
  expect(verified.valid === true, `receipt signature failed (${verified.reason ?? 'unknown'})`);
  expect(
    verified.payloadHash === expectedHash,
    'verified payload hash does not match the stored hash',
  );
  if (failures.length > 0)
    throw new Error(`Restored data failed integrity checks: ${failures.join('; ')}`);
  return {
    schoolCode: report.schoolCode,
    invoice: report.invoiceStatus,
    payment: report.paymentStatus,
    receiptNo: report.receiptNo,
    payloadHash: report.payloadHash,
    signatureValid: true,
    chainHead: report.sequence === 1 && report.prevHash === null,
  };
}

async function removeContainer(name) {
  assertOwnedContainer(name);
  await spawnText('docker', ['rm', '-f', name]);
}

export async function verifyIsolatedRestore({ repoRoot, appDatabaseUrl, destinationDir }) {
  const shared = createRequire(path.join(repoRoot, 'packages/shared/package.json'))(
    path.join(repoRoot, 'packages/shared/dist/index.js'),
  );
  const receipt = syntheticReceipt(shared);
  const payloadHash = await shared.receiptPayloadHash(receipt.payload);
  const app = parseDatabaseUrl(appDatabaseUrl);
  const name = disposableContainerName();
  const password = randomBytes(18).toString('base64url');
  let started = false;
  try {
    const created = await spawnText(
      'docker',
      [
        'run',
        '-d',
        '--name',
        name,
        '-p',
        '127.0.0.1::5432',
        '-e',
        'POSTGRES_USER=payment_owner',
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        'POSTGRES_DB=backup_src',
        'postgres:17-alpine',
      ],
      { secrets: [password] },
    );
    if (created.code !== 0)
      throw new Error(`Could not start the isolated database. ${created.stderr}`.trim());
    started = true;
    const mapped = await spawnText('docker', ['port', name, '5432/tcp']);
    if (mapped.code !== 0)
      throw new Error(`Could not read the isolated database port. ${mapped.stderr}`.trim());
    const port = publishedPort(mapped.stdout);
    if (port === app.port)
      throw new Error(
        'Isolated database published the application database port. Restore was not attempted.',
      );
    const srcUrl = databaseUrl(password, port, 'backup_src');
    const dstUrl = databaseUrl(password, port, 'backup_dst');
    assertSafeRestoreTarget(dstUrl, appDatabaseUrl);
    const readyAt = Date.now();
    let ready = false;
    while (Date.now() - readyAt < 40_000) {
      const probe = await spawnText('docker', [
        'exec',
        name,
        'psql',
        '-U',
        'payment_owner',
        '-d',
        'backup_src',
        '-t',
        '-A',
        '-c',
        'SELECT 1',
      ]);
      if (probe.code === 0 && probe.stdout.includes('1')) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Isolated Postgres did not become ready.');
    await psql(name, 'backup_src', 'CREATE DATABASE backup_dst;');
    const prismaPkg = createRequire(path.join(repoRoot, 'packages/db/package.json')).resolve(
      'prisma/package.json',
    );
    const prismaCli = path.join(path.dirname(prismaPkg), 'build/index.js');
    const migrated = await spawnText(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: path.join(repoRoot, 'packages/db'),
      env: { MIGRATION_DATABASE_URL: srcUrl, DATABASE_URL: srcUrl },
      secrets: [password],
    });
    if (migrated.code !== 0) {
      throw new Error(
        hideSensitive(
          `Migrations failed on the isolated database (exit ${migrated.code}). ${migrated.stderr}`.trim(),
          [password],
        ),
      );
    }
    await psql(name, 'backup_src', insertSql(receipt, payloadHash), [password]);
    const backup = await createBackup({
      env: { MIGRATION_DATABASE_URL: srcUrl },
      destinationDir,
      now: new Date(),
    });
    await restoreDump({ dumpPath: backup.dumpPath, targetUrl: dstUrl, appUrl: appDatabaseUrl });
    const raw = await psql(name, 'backup_dst', REPORT_SQL, [password]);
    if (!raw) throw new Error('Restored database did not return the synthetic financial records.');
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      throw new Error('Restored database returned a report that was not JSON.');
    }
    const summary = await verifyRestoredRecords(report, payloadHash, receipt.publicKeyRaw, shared);
    return { container: name, dumpPath: backup.dumpPath, sha256: backup.sha256, summary };
  } finally {
    if (started) await removeContainer(name);
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let fileEnv = {};
  try {
    fileEnv = loadEnvFile(await readFile(path.join(repoRoot, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const env = { ...fileEnv, ...process.env };
  const appDatabaseUrl = env.MIGRATION_DATABASE_URL;
  if (!appDatabaseUrl)
    throw new Error(
      'MIGRATION_DATABASE_URL is required so restore can prove it is not targeting the application database.',
    );
  const destinationDir = path.resolve(repoRoot, env.BACKUP_DIR || 'backups');
  const scratch = await mkdtemp(path.join(tmpdir(), 'payment-backup-'));
  try {
    const result = await verifyIsolatedRestore({
      repoRoot,
      appDatabaseUrl,
      destinationDir: env.BACKUP_KEEP === '1' ? destinationDir : scratch,
    });
    process.stdout.write(
      `Isolated restore verified.\nDump: ${result.dumpPath}\nSHA-256: ${result.sha256}\nSchool ${result.summary.schoolCode}, invoice ${result.summary.invoice}, payment ${result.summary.payment}, receipt ${result.summary.receiptNo}, signature valid, chain head intact.\n`,
    );
  } finally {
    if (env.BACKUP_KEEP !== '1') await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
