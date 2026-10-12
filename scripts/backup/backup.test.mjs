import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSafeRestoreTarget,
  createBackup,
  loadEnvFile,
  parseDatabaseUrl,
  restoreDump,
  writeChecksum,
} from './lib.mjs';
import { assertOwnedContainer, verifyIsolatedRestore } from './restore-verify.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_URL = 'postgresql://payment_owner:app-secret@localhost:5436/payment';
const OTHER_URL = 'postgresql://payment_owner:other-secret@127.0.0.1:59999/backup_dst';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'payment-backup-test-'));
}

test('backup fails when the database URL is missing', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => createBackup({ env: {}, destinationDir: dir }),
      /MIGRATION_DATABASE_URL is required/,
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed dump is not reported as a backup', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () =>
        createBackup({
          env: {
            MIGRATION_DATABASE_URL: 'postgresql://payment_owner:app-secret@127.0.0.1:5436/payment',
          },
          destinationDir: dir,
          runDump: async () => ({ code: 1, stderr: 'connection failed for app-secret' }),
        }),
      (error) => {
        assert.match(error.message, /pg_dump failed/);
        assert.equal(error.message.includes('app-secret'), false);
        return true;
      },
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore rejects a checksum mismatch and a corrupt dump', async () => {
  const dir = await tempDir();
  const dumpPath = path.join(dir, 'payment-test.dump');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dumpPath, Buffer.concat([Buffer.from('PGDMP'), Buffer.from('synthetic')]));
    await writeFile(`${dumpPath}.sha256`, `${'ab'.repeat(32)}  payment-test.dump\n`);
    await assert.rejects(
      () =>
        restoreDump({
          dumpPath,
          targetUrl: OTHER_URL,
          appUrl: APP_URL,
          runRestore: async () => ({ code: 0, stderr: '' }),
        }),
      /checksum does not match/,
    );
    await writeChecksum(dumpPath);
    const corrupt = path.join(dir, 'corrupt.dump');
    await writeFile(corrupt, Buffer.from('not-a-dump'));
    await writeChecksum(corrupt);
    await assert.rejects(
      () =>
        restoreDump({
          dumpPath: corrupt,
          targetUrl: OTHER_URL,
          appUrl: APP_URL,
          runRestore: async () => ({ code: 0, stderr: '' }),
        }),
      /not a PostgreSQL custom-format dump/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore failure is reported', async () => {
  const dir = await tempDir();
  const dumpPath = path.join(dir, 'payment-test.dump');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dumpPath, Buffer.concat([Buffer.from('PGDMP'), Buffer.from('synthetic')]));
    await writeChecksum(dumpPath);
    await assert.rejects(
      () =>
        restoreDump({
          dumpPath,
          targetUrl: OTHER_URL,
          appUrl: APP_URL,
          runRestore: async () => ({ code: 2, stderr: 'archive is corrupt' }),
        }),
      /pg_restore failed \(exit 2\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore refuses the active application database', () => {
  assert.throws(
    () => assertSafeRestoreTarget('postgresql://payment_owner:pw@127.0.0.1:5436/payment', APP_URL),
    /active application database/,
  );
  assert.throws(
    () => assertSafeRestoreTarget('postgresql://payment_owner:pw@localhost:5436/payment', APP_URL),
    /active application database/,
  );
  assert.throws(() => assertSafeRestoreTarget(OTHER_URL, ''), /without MIGRATION_DATABASE_URL/);
  const allowed = assertSafeRestoreTarget(OTHER_URL, APP_URL);
  assert.equal(allowed.database, 'backup_dst');
  assert.equal(allowed.port, '59999');
});

test('cleanup refuses containers it did not create', () => {
  assert.throws(() => assertOwnedContainer('payment-platform-postgres-1'), /did not create/);
  assert.doesNotThrow(() => assertOwnedContainer('payment-backup-verify-ab12cd34'));
});

test('injected backup and restore succeed only for a valid custom dump', async () => {
  const dir = await tempDir();
  try {
    const created = await createBackup({
      env: { MIGRATION_DATABASE_URL: APP_URL },
      destinationDir: dir,
      now: new Date('2026-10-12T12:00:00.000Z'),
      runDump: async (dumpPath) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(dumpPath, Buffer.concat([Buffer.from('PGDMP'), Buffer.from('synthetic')]));
        return { code: 0, stderr: '' };
      },
    });
    assert.match(path.basename(created.dumpPath), /^payment-20261012T120000Z\.dump$/);
    assert.match(created.sha256, /^[a-f0-9]{64}$/);
    const restored = await restoreDump({
      dumpPath: created.dumpPath,
      targetUrl: OTHER_URL,
      appUrl: APP_URL,
      runRestore: async () => ({ code: 0, stderr: '' }),
    });
    assert.equal(restored.database, 'backup_dst');
    await assert.rejects(
      () =>
        restoreDump({
          dumpPath: created.dumpPath,
          targetUrl: APP_URL,
          appUrl: APP_URL,
          runRestore: async () => ({ code: 0, stderr: '' }),
        }),
      /active application database/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'isolated backup and restore keeps synthetic financial records and the receipt signature',
  { timeout: 180_000 },
  async () => {
    const env = loadEnvFile(await readFile(path.join(repoRoot, '.env'), 'utf8'));
    const appUrl = env.MIGRATION_DATABASE_URL;
    assert.ok(appUrl, 'MIGRATION_DATABASE_URL');
    const app = parseDatabaseUrl(appUrl);
    assert.equal(app.database, 'payment');
    const dir = await tempDir();
    try {
      const result = await verifyIsolatedRestore({
        repoRoot,
        appDatabaseUrl: appUrl,
        destinationDir: dir,
      });
      assert.equal(result.summary.schoolCode, 'SYNTH');
      assert.equal(result.summary.invoice, 'PAID');
      assert.equal(result.summary.payment, 'SUCCEEDED');
      assert.equal(result.summary.receiptNo, 'SYNTH-R-0000001');
      assert.equal(result.summary.signatureValid, true);
      assert.equal(result.summary.chainHead, true);
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.summary.payloadHash.length, 64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
