import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

const PGDMP = Buffer.from('PGDMP');

export function loadEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function requireDatabaseUrl(env) {
  const url = env.MIGRATION_DATABASE_URL || env.DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error('MIGRATION_DATABASE_URL is required to back up the database (the owner role).');
  }
  return url.trim();
}

export function parseDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Database URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Database URL must use the postgresql scheme.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database || !parsed.username) {
    throw new Error('Database URL must include a host, database name, and user.');
  }
  const port = parsed.port || '5432';
  return {
    host: parsed.hostname,
    port,
    database,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

export function normalizeHost(host) {
  const value = host.toLowerCase();
  if (value === 'localhost' || value === '::1') return '127.0.0.1';
  return value;
}

/** Throws when the restore target is the same server and database the application uses. */
export function assertSafeRestoreTarget(targetUrl, appUrl) {
  if (!appUrl || !String(appUrl).trim()) {
    throw new Error(
      'Refusing to restore without MIGRATION_DATABASE_URL to compare against the application database.',
    );
  }
  const target = parseDatabaseUrl(targetUrl);
  const app = parseDatabaseUrl(appUrl);
  const sameServer =
    normalizeHost(target.host) === normalizeHost(app.host) && target.port === app.port;
  if (sameServer && target.database === app.database) {
    throw new Error('Refusing to restore into the active application database.');
  }
  return target;
}

export function scrub(text, secrets) {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output;
}

export async function assertCustomDump(dumpPath) {
  const handle = await open(dumpPath, 'r');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, 5, 0);
    if (bytesRead < 5 || !header.subarray(0, 5).equals(PGDMP)) {
      throw new Error('Backup file is not a PostgreSQL custom-format dump.');
    }
  } finally {
    await handle.close();
  }
  const info = await stat(dumpPath);
  if (info.size < 5) throw new Error('Backup file is empty.');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function writeChecksum(dumpPath) {
  const digest = await sha256File(dumpPath);
  const checksumPath = `${dumpPath}.sha256`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(checksumPath, `${digest}  ${path.basename(dumpPath)}\n`, { mode: 0o600 });
  return { checksumPath, sha256: digest };
}

export async function verifyChecksum(dumpPath, checksumPath = `${dumpPath}.sha256`) {
  const recorded = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(recorded ?? ''))
    throw new Error('Checksum file is missing a SHA-256 digest.');
  const actual = await sha256File(dumpPath);
  if (actual.toLowerCase() !== recorded.toLowerCase()) {
    throw new Error('Backup checksum does not match the dump file.');
  }
  return actual;
}

export function spawnText(command, args, { input, env, secrets = [], cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => reject(new Error(scrub(error.message, secrets))));
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: scrub(Buffer.concat(stderr).toString('utf8'), secrets),
      });
    });
    if (input === undefined) child.stdin.end();
    else {
      child.stdin.end(input);
    }
  });
}

export function spawnChecked(command, args, { inputPath, outputPath, env, secrets = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: [inputPath ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stderrChunks = [];
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    let outputDone = Promise.resolve();
    if (outputPath) {
      const output = createWriteStream(outputPath);
      child.stdout.pipe(output);
      outputDone = new Promise((done, fail) => {
        output.on('finish', done);
        output.on('error', fail);
      });
    } else {
      child.stdout.resume();
    }
    if (inputPath) {
      const input = createReadStream(inputPath);
      input.on('error', reject);
      input.pipe(child.stdin);
    }
    child.on('error', (error) => reject(new Error(scrub(error.message, secrets))));
    child.on('close', (code) => {
      outputDone
        .then(() =>
          resolve({
            code: code ?? 1,
            stderr: scrub(Buffer.concat(stderrChunks).toString('utf8'), secrets),
          }),
        )
        .catch(reject);
    });
  });
}

export function dockerHost(host) {
  if (normalizeHost(host) === '127.0.0.1') return 'host.docker.internal';
  return host;
}

export function pgDumpArgs(parsed) {
  return [
    'run',
    '--rm',
    '-e',
    'PGPASSWORD',
    'postgres:17-alpine',
    'pg_dump',
    '-h',
    dockerHost(parsed.host),
    '-p',
    parsed.port,
    '-U',
    parsed.user,
    '-d',
    parsed.database,
    '-Fc',
    '--no-owner',
    '--no-acl',
  ];
}

export function pgRestoreArgs(parsed) {
  return [
    'run',
    '--rm',
    '-i',
    '-e',
    'PGPASSWORD',
    'postgres:17-alpine',
    'pg_restore',
    '-h',
    dockerHost(parsed.host),
    '-p',
    parsed.port,
    '-U',
    parsed.user,
    '-d',
    parsed.database,
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
  ];
}

async function restrictPermissions(filePath) {
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o600);
    return true;
  }
  const user = userInfo().username;
  const result = await spawnChecked(
    'icacls',
    [filePath, '/inheritance:r', '/grant:r', `${user}:(R,W)`],
    {},
  );
  return result.code === 0;
}

export async function createBackup({ env, destinationDir, now = new Date(), runDump }) {
  const databaseUrl = requireDatabaseUrl(env);
  const parsed = parseDatabaseUrl(databaseUrl);
  if (!destinationDir) throw new Error('BACKUP_DIR is required.');
  await mkdir(destinationDir, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dumpPath = path.join(destinationDir, `payment-${stamp}.dump`);
  const dump =
    runDump ??
    ((target) =>
      spawnChecked('docker', pgDumpArgs(parsed), {
        outputPath: target,
        env: { PGPASSWORD: parsed.password },
        secrets: [parsed.password],
      }));
  try {
    const result = await dump(dumpPath);
    if (result.code !== 0) {
      throw new Error(
        scrub(`pg_dump failed (exit ${result.code}). ${result.stderr}`.trim(), [parsed.password]),
      );
    }
    await access(dumpPath);
    await assertCustomDump(dumpPath);
  } catch (error) {
    await rm(dumpPath, { force: true });
    throw error;
  }
  const checksum = await writeChecksum(dumpPath);
  const restricted =
    (await restrictPermissions(dumpPath)) && (await restrictPermissions(checksum.checksumPath));
  return {
    dumpPath,
    checksumPath: checksum.checksumPath,
    sha256: checksum.sha256,
    permissionsRestricted: restricted,
  };
}

export async function restoreDump({ dumpPath, targetUrl, appUrl, runRestore }) {
  await verifyChecksum(dumpPath);
  await assertCustomDump(dumpPath);
  const target = assertSafeRestoreTarget(targetUrl, appUrl);
  const restore =
    runRestore ??
    (() =>
      spawnChecked('docker', pgRestoreArgs(target), {
        inputPath: dumpPath,
        env: { PGPASSWORD: target.password },
        secrets: [target.password],
      }));
  const result = await restore();
  if (result.code !== 0) {
    throw new Error(
      scrub(`pg_restore failed (exit ${result.code}). ${result.stderr}`.trim(), [target.password]),
    );
  }
  return target;
}
