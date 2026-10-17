import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnText } from '../backup/lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREFIX = 'payment-deploy-check';
const network = PREFIX;
const pgVolume = `${PREFIX}-pg`;
const redisVolume = `${PREFIX}-redis`;
const names = {
  postgres: `${PREFIX}-postgres`,
  redis: `${PREFIX}-redis`,
  api: `${PREFIX}-api`,
  worker: `${PREFIX}-worker`,
  web: `${PREFIX}-web`,
};

function assertOwned(name) {
  if (!name.startsWith(`${PREFIX}`)) throw new Error(`Refusing to touch ${name}`);
}

function redact(text, secrets) {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output;
}

async function docker(args, secrets = []) {
  const result = await spawnText('docker', args, { secrets });
  if (result.code !== 0) {
    throw new Error(
      redact(`${args[0]} failed (exit ${result.code}). ${result.stderr}`.trim(), secrets),
    );
  }
  return result.stdout.trim();
}

function publishedPort(text) {
  const match = text.match(/:(\d+)\s*$/m);
  if (!match?.[1]) throw new Error('Docker did not publish a port');
  return match[1];
}

async function waitFor(label, attempt, timeoutMs = 60_000) {
  const started = Date.now();
  let last = 'not ready';
  while (Date.now() - started < timeoutMs) {
    try {
      if (await attempt()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : 'not ready';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} was not ready in time. ${last}`);
}

function receiptMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    id: 'deploy-check',
    privateKey: Buffer.from(privatePem).toString('base64'),
    publicKey: publicKey.export({ format: 'jwk' }).x,
  };
}

async function removeDisposable() {
  for (const name of Object.values(names)) {
    assertOwned(name);
    await spawnText('docker', ['rm', '-f', name]);
  }
  for (const volume of [pgVolume, redisVolume]) {
    assertOwned(volume);
    await spawnText('docker', ['volume', 'rm', '-f', volume]);
  }
  assertOwned(network);
  await spawnText('docker', ['network', 'rm', network]);
}

async function platformState() {
  const ids = await spawnText('docker', ['ps', '-aq', '--filter', 'name=payment-platform']);
  const list = ids.stdout.trim().split(/\s+/).filter(Boolean);
  if (list.length === 0) return '';
  const result = await spawnText('docker', [
    'inspect',
    '--format',
    '{{.Name}} {{.Id}} {{.State.Status}} {{.State.StartedAt}}',
    ...list,
  ]);
  if (result.code !== 0) throw new Error('Could not inspect the developer containers.');
  return result.stdout
    .trim()
    .split('\n')
    .sort()
    .join('\n');
}

async function apiStatus(pathname) {
  const result = await spawnText('docker', [
    'exec',
    names.api,
    'wget',
    '-q',
    '-S',
    '-O',
    '-',
    `http://127.0.0.1:4000${pathname}`,
  ]);
  const match = `${result.stderr}\n${result.stdout}`.match(/HTTP\/\d(?:\.\d)? (\d{3})/);
  if (!match?.[1]) throw new Error(result.stderr.trim() || 'API did not answer inside the container');
  return { status: Number(match[1]), body: result.stdout };
}

async function fetchStatus(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

async function main() {
  for (const name of Object.values(names)) assertOwned(name);
  assertOwned(pgVolume);
  assertOwned(redisVolume);
  assertOwned(network);
  for (const image of ['payment-api', 'payment-worker']) {
    const found = await spawnText('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    if (found.code !== 0) throw new Error(`Missing image ${image}. Build it before this check.`);
  }
  const webImage = await spawnText('docker', ['image', 'inspect', 'payment-web', '--format', '{{.Id}}']);
  const webAvailable = webImage.code === 0;
  const before = await platformState();
  await removeDisposable();
  const ownerPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  const jwt = randomBytes(36).toString('base64url');
  const dataKey = randomBytes(32).toString('base64');
  const chapaSecret = `chapa-dummy-${randomBytes(8).toString('hex')}`;
  const chapaWebhook = `chapa-hook-${randomBytes(8).toString('hex')}`;
  const receipt = receiptMaterial();
  const secrets = [
    ownerPassword,
    appPassword,
    jwt,
    dataKey,
    chapaSecret,
    chapaWebhook,
    receipt.privateKey,
    receipt.publicKey,
  ];
  const started = [];
  const log = (line) => process.stdout.write(`${line}\n`);

  try {
    await docker(['network', 'create', network]);
    const apiEnv = [
      'DATABASE_URL',
      `postgresql://payment_app:${encodeURIComponent(appPassword)}@${names.postgres}:5432/payment`,
      'REDIS_URL',
      `redis://${names.redis}:6379`,
      'API_PUBLIC_URL',
      'http://127.0.0.1:4000',
      'WEB_URL',
      'http://127.0.0.1:3000',
      'JWT_ACCESS_SECRET',
      jwt,
      'DATA_ENCRYPTION_KEY',
      dataKey,
      'RECEIPT_SIGNING_KEY_ID',
      receipt.id,
      'RECEIPT_SIGNING_PRIVATE_KEY',
      receipt.privateKey,
      'RECEIPT_SIGNING_PUBLIC_KEY',
      receipt.publicKey,
      'PAYMENT_GATEWAY',
      'chapa',
      'CHAPA_SECRET_KEY',
      chapaSecret,
      'CHAPA_WEBHOOK_SECRET',
      chapaWebhook,
      'SMS_PROVIDER',
      'console',
    ];
    const apiFlags = [];
    for (let index = 0; index < apiEnv.length; index += 2) {
      apiFlags.push('-e', `${apiEnv[index]}=${apiEnv[index + 1]}`);
    }
    await docker(
      [
        'run',
        '-d',
        '--name',
        names.api,
        '--network',
        network,
        '-p',
        '127.0.0.1::4000',
        ...apiFlags,
        'payment-api',
      ],
      secrets,
    );
    started.push(names.api);
    const apiPort = publishedPort(await docker(['port', names.api, '4000/tcp']));
    if (apiPort === '4000') throw new Error('Disposable API published the developer API port.');
    await waitFor('API liveness without dependencies', async () => {
      const response = await fetchStatus(`http://127.0.0.1:${apiPort}/health/live`);
      if (response.status !== 200) throw new Error(`live ${response.status}`);
      return true;
    });
    const earlyReady = await fetchStatus(`http://127.0.0.1:${apiPort}/health/ready`);
    if (earlyReady.status !== 503)
      throw new Error(`Readiness returned ${earlyReady.status} before Postgres and Redis existed.`);
    if (earlyReady.body.includes(appPassword) || earlyReady.body.includes('postgresql://')) {
      throw new Error('Readiness response leaked connection details.');
    }
    log('API stayed live and reported not ready while Postgres and Redis were absent.');
    const apiId = await docker(['inspect', '-f', '{{.Id}}', names.api]);

    await docker(
      [
        'run',
        '-d',
        '--name',
        names.postgres,
        '--network',
        network,
        '-p',
        '127.0.0.1::5432',
        '-e',
        'POSTGRES_USER=payment_owner',
        '-e',
        `POSTGRES_PASSWORD=${ownerPassword}`,
        '-e',
        'POSTGRES_DB=payment',
        '-e',
        'APP_DB_USER=payment_app',
        '-e',
        `APP_DB_PASSWORD=${appPassword}`,
        '-v',
        `${pgVolume}:/var/lib/postgresql/data`,
        '-v',
        `${path.join(repoRoot, 'infra/postgres/init')}:/docker-entrypoint-initdb.d:ro`,
        'postgres:17-alpine',
      ],
      secrets,
    );
    started.push(names.postgres);
    const pgPort = publishedPort(await docker(['port', names.postgres, '5432/tcp']));
    if (pgPort === '5436')
      throw new Error('Disposable Postgres published the developer database port.');
    await waitFor('disposable Postgres', async () => {
      const probe = await spawnText('docker', [
        'exec',
        names.postgres,
        'pg_isready',
        '-U',
        'payment_owner',
        '-d',
        'payment',
      ]);
      if (probe.code !== 0) throw new Error('pg_isready');
      return true;
    });

    await docker([
      'run',
      '-d',
      '--name',
      names.redis,
      '--network',
      network,
      '-p',
      '127.0.0.1::6379',
      '-v',
      `${redisVolume}:/data`,
      'redis:7-alpine',
      'redis-server',
      '--appendonly',
      'yes',
      '--maxmemory-policy',
      'noeviction',
    ]);
    started.push(names.redis);
    const redisPort = publishedPort(await docker(['port', names.redis, '6379/tcp']));
    if (redisPort === '6380')
      throw new Error('Disposable Redis published the developer Redis port.');

    await waitFor(
      'API readiness after dependencies started',
      async () => {
        const response = await fetchStatus(`http://127.0.0.1:${apiPort}/health/ready`);
        if (response.status !== 200)
          throw new Error(`ready ${response.status} ${response.body.slice(0, 120)}`);
        return true;
      },
      90_000,
    );
    if ((await docker(['inspect', '-f', '{{.Id}}', names.api])) !== apiId) {
      throw new Error('API container was replaced while dependencies recovered.');
    }
    log('API became ready after Postgres and Redis appeared, without a restart.');

    const migrationUrl = `postgresql://payment_owner:${encodeURIComponent(ownerPassword)}@127.0.0.1:${pgPort}/payment`;
    const prismaPkg = createRequire(path.join(repoRoot, 'packages/db/package.json')).resolve(
      'prisma/package.json',
    );
    const migrate = async () => {
      const result = await spawnText(
        process.execPath,
        [path.join(path.dirname(prismaPkg), 'build/index.js'), 'migrate', 'deploy'],
        {
          cwd: path.join(repoRoot, 'packages/db'),
          env: { MIGRATION_DATABASE_URL: migrationUrl, DATABASE_URL: migrationUrl },
          secrets,
        },
      );
      if (result.code !== 0) throw new Error(redact(`Migration failed. ${result.stderr}`, secrets));
    };
    await migrate();
    await psql(
      names.postgres,
      `INSERT INTO "School" (id, name, code, status, "contactEmail", "contactPhone", "updatedAt") VALUES ('sch_deploy_check', 'Synthetic Deploy Academy', 'SYNTH', 'ACTIVE', 'synthetic@example.test', '+251900000000', CURRENT_TIMESTAMP);`,
    );
    await migrate();
    if (
      (await psql(names.postgres, `SELECT count(*) FROM "School" WHERE code = 'SYNTH';`)) !== '1'
    ) {
      throw new Error('A second migrate deploy did not keep the synthetic school.');
    }
    log('migrate deploy applied once and did not remove the synthetic school when run again.');

    await docker(['restart', names.api]);
    await waitFor(
      'API after restart',
      async () => (await apiStatus('/health/ready')).status === 200,
      90_000,
    );
    if (
      (await psql(names.postgres, `SELECT count(*) FROM "School" WHERE code = 'SYNTH';`)) !== '1'
    ) {
      throw new Error('Synthetic school disappeared after an API restart.');
    }
    log('API restart left the synthetic school in place.');

    await docker(['exec', names.redis, 'redis-cli', 'SET', 'deploycheck', '1']);
    await docker(['restart', names.redis]);
    await waitFor('Redis after restart', async () =>
      (await spawnText('docker', ['exec', names.redis, 'redis-cli', 'PING'])).stdout.includes(
        'PONG',
      ),
    );
    if ((await docker(['exec', names.redis, 'redis-cli', 'GET', 'deploycheck'])) !== '1') {
      throw new Error('Redis AOF did not keep a key across a container restart.');
    }
    await waitFor(
      'API after Redis restart',
      async () => (await apiStatus('/health/ready')).status === 200,
      90_000,
    );
    log('Redis restart kept AOF data and the API became ready again.');

    await docker(['stop', names.redis]);
    await waitFor(
      'readiness while Redis is stopped',
      async () => (await apiStatus('/health/ready')).status === 503,
      90_000,
    );
    await docker(['start', names.redis]);
    await waitFor(
      'API after Redis returned',
      async () => (await apiStatus('/health/ready')).status === 200,
      90_000,
    );
    if ((await docker(['inspect', '-f', '{{.Id}}', names.api])) !== apiId)
      throw new Error('API was recreated while Redis recovered.');
    log('Stopping Redis made readiness fail, and starting it recovered the same API process.');

    await docker(['restart', names.postgres]);
    await waitFor('Postgres after restart', async () => {
      const probe = await spawnText('docker', [
        'exec',
        names.postgres,
        'pg_isready',
        '-U',
        'payment_owner',
        '-d',
        'payment',
      ]);
      return probe.code === 0;
    });
    if (
      (await psql(names.postgres, `SELECT count(*) FROM "School" WHERE code = 'SYNTH';`)) !== '1'
    ) {
      throw new Error('Synthetic school disappeared after a Postgres restart.');
    }
    await waitFor(
      'API after Postgres restart',
      async () => (await apiStatus('/health/ready')).status === 200,
      90_000,
    );
    log('Postgres restart kept the synthetic school and the API recovered.');

    await docker(['rm', '-f', names.postgres]);
    await docker(
      [
        'run',
        '-d',
        '--name',
        names.postgres,
        '--network',
        network,
        '-p',
        '127.0.0.1::5432',
        '-e',
        'POSTGRES_USER=payment_owner',
        '-e',
        `POSTGRES_PASSWORD=${ownerPassword}`,
        '-e',
        'POSTGRES_DB=payment',
        '-e',
        'APP_DB_USER=payment_app',
        '-e',
        `APP_DB_PASSWORD=${appPassword}`,
        '-v',
        `${pgVolume}:/var/lib/postgresql/data`,
        'postgres:17-alpine',
      ],
      secrets,
    );
    const recreatedPg = publishedPort(await docker(['port', names.postgres, '5432/tcp']));
    if (recreatedPg === '5436')
      throw new Error('Recreated Postgres published the developer database port.');
    await waitFor(
      'recreated Postgres',
      async () =>
        (await psql(names.postgres, `SELECT count(*) FROM "School" WHERE code = 'SYNTH';`)) === '1',
    );
    log('Recreating the Postgres container on the same volume kept the synthetic school.');

    await docker(
      ['run', '-d', '--name', names.worker, '--network', network, ...apiFlags, 'payment-worker'],
      secrets,
    );
    started.push(names.worker);
    await waitFor('worker log', async () => {
      const logs = redact(await docker(['logs', names.worker], secrets), secrets);
      if (!logs.includes('Worker started')) throw new Error('worker has not logged startup');
      if (logs.includes('API listening')) throw new Error('Worker logged an API listener.');
      return true;
    });
    const probeApi = await spawnText('docker', [
      'exec',
      names.worker,
      'wget',
      '-q',
      '-O',
      '-',
      'http://127.0.0.1:4000/health/live',
    ]);
    if (probeApi.code === 0) throw new Error('Worker accepted an HTTP liveness request.');
    log('Worker started without listening for HTTP.');

    await docker(['stop', '-t', '20', names.worker]);
    await docker([
      'cp',
      path.join(repoRoot, 'scripts/deploy/queue-probe.cjs'),
      `${names.api}:/app/queue-probe.cjs`,
    ]);
    const queueCommand = async (command, jobId) => {
      const result = await spawnText('docker', [
        'exec',
        '-w',
        '/app',
        names.api,
        'node',
        'queue-probe.cjs',
        command,
        jobId,
      ]);
      if (result.code !== 0) throw new Error(`queue ${command} failed (exit ${result.code})`);
      return result.stdout.trim();
    };
    await queueCommand('add', 'deploy-check-1');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await docker(['restart', names.redis]);
    await waitFor('Redis after queue restart', async () =>
      (await spawnText('docker', ['exec', names.redis, 'redis-cli', 'PING'])).stdout.includes(
        'PONG',
      ),
    );
    const survivedAt = Date.now();
    let survived = 'unknown';
    while (Date.now() - survivedAt < 20_000) {
      try {
        survived = await queueCommand('state', 'deploy-check-1');
      } catch {
        survived = 'unknown';
      }
      if (
        survived === 'waiting' ||
        survived === 'delayed' ||
        survived === 'active' ||
        survived === 'completed'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (
      survived !== 'waiting' &&
      survived !== 'delayed' &&
      survived !== 'active' &&
      survived !== 'completed'
    ) {
      throw new Error(`Queued job did not survive the Redis restart (state ${survived}).`);
    }
    await docker(['start', names.worker]);
    await waitFor('missing payment job', async () => {
      const state = await queueCommand('state', 'deploy-check-1');
      if (state === 'failed') throw new Error('verification job failed');
      return state === 'completed';
    });
    if ((await psql(names.postgres, 'SELECT count(*) FROM "LedgerEntry";')) !== '0') {
      throw new Error('Worker wrote a ledger entry for a missing payment.');
    }
    if ((await psql(names.postgres, 'SELECT count(*) FROM "Payment";')) !== '0') {
      throw new Error('Worker created a payment row for a missing reference.');
    }
    await queueCommand('add', 'deploy-check-2');
    await waitFor(
      'second missing payment job',
      async () => (await queueCommand('state', 'deploy-check-2')) === 'completed',
    );
    if ((await psql(names.postgres, 'SELECT count(*) FROM "LedgerEntry";')) !== '0') {
      throw new Error('A second worker delivery wrote a ledger entry.');
    }
    log(
      'Worker resumed a queued verification after a Redis restart and did not write financial rows.',
    );
    await docker(['stop', '-t', '20', names.worker]);
    const workerExit = await docker(['inspect', '-f', '{{.State.ExitCode}}', names.worker]);
    if (workerExit !== '0') throw new Error(`Worker exit code after SIGTERM was ${workerExit}.`);
    log('Worker exited 0 after SIGTERM.');

    if (webAvailable) {
      await docker([
        'run',
        '-d',
        '--name',
        names.web,
        '--network',
        network,
        '-p',
        '127.0.0.1::3000',
        '-e',
        `API_URL=http://${names.api}:4000`,
        'payment-web',
      ]);
      started.push(names.web);
      const webPort = publishedPort(await docker(['port', names.web, '3000/tcp']));
      if (webPort === '3000') throw new Error('Disposable web published the developer web port.');
      await waitFor('web process', async () => {
        const response = await fetchStatus(`http://127.0.0.1:${webPort}/`);
        if (response.status >= 500) throw new Error(`web ${response.status}`);
        return true;
      });
      log('Web image responded with the runtime API_URL set on the container.');
    } else {
      log('Web image is not present, so the web container was not started.');
    }

    const noEnv = await spawnText('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      'payment-api',
      '-e',
      "const fs=require('fs'); if (['.env','.env.local'].some((name)=>fs.existsSync(name))) process.exit(1); if (!fs.existsSync('dist/main.js') || !fs.existsSync('dist/worker.js')) process.exit(2);",
    ]);
    if (noEnv.code !== 0)
      throw new Error(
        `API image is missing compiled files or contains an env file (exit ${noEnv.code}).`,
      );
    const imageUser = await docker([
      'image',
      'inspect',
      'payment-api',
      '--format',
      '{{.Config.User}} {{json .Config.Cmd}}',
    ]);
    if (!imageUser.includes('node') || !imageUser.includes('dist/main.js'))
      throw new Error(`Unexpected API image command: ${imageUser}`);
    const workerCmd = await docker([
      'image',
      'inspect',
      'payment-worker',
      '--format',
      '{{json .Config.Cmd}} {{json .Config.Healthcheck}}',
    ]);
    if (!workerCmd.includes('dist/worker.js') || !workerCmd.includes('NONE'))
      throw new Error(`Unexpected worker image health or command: ${workerCmd}`);
    log('Images contain the compiled entrypoints, no env file, and the worker has no HTTP probe.');

    await docker(['stop', '-t', '20', names.api]);
    const apiExit = await docker(['inspect', '-f', '{{.State.ExitCode}}', names.api]);
    if (apiExit !== '0') throw new Error(`API exit code after SIGTERM was ${apiExit}.`);
    log('API exited 0 after SIGTERM.');

    const after = await platformState();
    if (after !== before)
      throw new Error('The developer payment-platform containers changed during this check.');
    log('Developer payment-platform containers were unchanged.');
  } catch (error) {
    for (const name of started) {
      const logs = await spawnText('docker', ['logs', '--tail', '60', name]);
      process.stderr.write(
        `--- ${name} ---\n${redact(`${logs.stdout}\n${logs.stderr}`, secrets)}\n`,
      );
    }
    throw error;
  } finally {
    await removeDisposable();
  }
}

async function psql(container, sql) {
  assertOwned(container);
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
      'payment',
      '-t',
      '-A',
    ],
    { input: sql },
  );
  if (result.code !== 0) throw new Error(`psql failed. ${result.stderr}`.trim());
  return result.stdout.trim();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'deployment check failed'}\n`);
  process.exitCode = 1;
});
