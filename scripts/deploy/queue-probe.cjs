'use strict';

const { Queue } = require('bullmq');
const Redis = require('ioredis');

async function main() {
  const [command, jobId] = process.argv.slice(2);
  if (!process.env.REDIS_URL || (command !== 'add' && command !== 'state') || !jobId) {
    process.exitCode = 2;
    return;
  }
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue('payment-verification', { connection });
  try {
    if (command === 'add') {
      await queue.add('verify-payment', { txRef: 'SYNTH-MISSING', reason: 'manual' }, { jobId });
      process.stdout.write('added\n');
      return;
    }
    const job = await queue.getJob(jobId);
    process.stdout.write(`${job ? await job.getState() : 'missing'}\n`);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.name : 'error'}\n`);
  process.exitCode = 1;
});
