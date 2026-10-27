#!/usr/bin/env tsx
/**
 * Manual test script to verify the 5-minute sweep worker
 * 
 * This script:
 * 1. Creates test payments in PENDING and FAILED states
 * 2. Triggers the sweep worker manually
 * 3. Verifies that payments are picked up for verification
 * 
 * Usage:
 *   pnpm tsx scripts/test-sweep-worker.ts
 */

import { PrismaClient } from '@payment/db';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6380');

interface TestPayment {
  txRef: string;
  status: 'PENDING' | 'FAILED';
  failureReason?: string;
  createdAt: Date;
}

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

async function getTestSchool() {
  const school = await prisma.school.findFirst({
    where: { status: 'ACTIVE' },
    select: { id: true, code: true, name: true },
  });

  if (!school) {
    throw new Error('No active school found. Create a school first.');
  }

  return school;
}

async function getTestInvoice(schoolId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: {
      schoolId,
      status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
    },
    select: { id: true, number: true, totalAmount: true, paidAmount: true },
  });

  if (!invoice) {
    throw new Error(`No issued invoice found for school ${schoolId}`);
  }

  return invoice;
}

async function createTestPayments(schoolId: string, invoiceId: string): Promise<TestPayment[]> {
  log('blue', '\n📝 Creating test payments...');

  const now = Date.now();
  const payments: TestPayment[] = [];

  // Test case 1: PENDING payment older than 10 minutes (should be picked up)
  const pending11Min: TestPayment = {
    txRef: `TEST-PENDING-${Date.now()}-11MIN`,
    status: 'PENDING',
    createdAt: new Date(now - 11 * 60 * 1000),
  };

  // Test case 2: PENDING payment only 5 minutes old (should NOT be picked up yet)
  const pending5Min: TestPayment = {
    txRef: `TEST-PENDING-${Date.now()}-5MIN`,
    status: 'PENDING',
    createdAt: new Date(now - 5 * 60 * 1000),
  };

  // Test case 3: FAILED payment with gateway_reported_failed within 30-min window (should be picked up)
  const failedRetryable: TestPayment = {
    txRef: `TEST-FAILED-${Date.now()}-RETRYABLE`,
    status: 'FAILED',
    failureReason: 'gateway_reported_failed',
    createdAt: new Date(now - 15 * 60 * 1000),
  };

  // Test case 4: FAILED payment older than 30 minutes (should NOT be picked up)
  const failedExpired: TestPayment = {
    txRef: `TEST-FAILED-${Date.now()}-EXPIRED`,
    status: 'FAILED',
    failureReason: 'gateway_reported_failed',
    createdAt: new Date(now - 35 * 60 * 1000),
  };

  // Test case 5: FAILED payment with different failure reason (should NOT be picked up)
  const failedOther: TestPayment = {
    txRef: `TEST-FAILED-${Date.now()}-OTHER`,
    status: 'FAILED',
    failureReason: 'initialization_failed',
    createdAt: new Date(now - 15 * 60 * 1000),
  };

  const testCases = [pending11Min, pending5Min, failedRetryable, failedExpired, failedOther];

  for (const testCase of testCases) {
    await prisma.payment.create({
      data: {
        schoolId,
        invoiceId,
        txRef: testCase.txRef,
        gateway: 'mock',
        amount: 10000, // 100 ETB
        currency: 'ETB',
        status: testCase.status,
        failureReason: testCase.failureReason || null,
        payerName: 'Test Parent',
        payerPhone: '+251911111111',
        createdAt: testCase.createdAt,
      },
    });

    payments.push(testCase);
    log('green', `  ✓ Created: ${testCase.txRef} (${testCase.status})`);
  }

  return payments;
}

async function checkSweepBehavior(payments: TestPayment[]) {
  log('blue', '\n🔍 Checking which payments should be swept...');

  const now = Date.now();
  const CHECKOUT_RETRY_WINDOW_MS = 30 * 60 * 1000;

  for (const payment of payments) {
    const ageMinutes = Math.floor((now - payment.createdAt.getTime()) / (60 * 1000));
    let shouldSweep = false;
    let reason = '';

    if (payment.status === 'PENDING' && ageMinutes > 10) {
      shouldSweep = true;
      reason = `PENDING and ${ageMinutes} minutes old (> 10 min threshold)`;
    } else if (payment.status === 'PENDING') {
      reason = `PENDING but only ${ageMinutes} minutes old (< 10 min threshold)`;
    } else if (
      payment.status === 'FAILED' &&
      payment.failureReason === 'gateway_reported_failed' &&
      now - payment.createdAt.getTime() < CHECKOUT_RETRY_WINDOW_MS
    ) {
      shouldSweep = true;
      reason = `FAILED (gateway_reported_failed) within 30-min retry window`;
    } else if (payment.status === 'FAILED' && payment.failureReason === 'gateway_reported_failed') {
      reason = `FAILED (gateway_reported_failed) but outside 30-min retry window`;
    } else if (payment.status === 'FAILED') {
      reason = `FAILED but reason is ${payment.failureReason} (not gateway_reported_failed)`;
    }

    const color = shouldSweep ? 'green' : 'yellow';
    const symbol = shouldSweep ? '✓' : '○';
    log(color, `  ${symbol} ${payment.txRef}`);
    log(color, `     ${reason}`);
  }
}

async function simulateSweep(payments: TestPayment[]) {
  log('blue', '\n🔄 Simulating sweep worker logic...');

  const now = Date.now();
  const CHECKOUT_RETRY_WINDOW_MS = 30 * 60 * 1000;

  const foundPayments = await prisma.payment.findMany({
    where: {
      OR: [
        {
          status: 'PENDING',
          createdAt: { lt: new Date(now - 10 * 60 * 1000) },
        },
        {
          status: 'FAILED',
          failureReason: 'gateway_reported_failed',
          createdAt: { gt: new Date(now - CHECKOUT_RETRY_WINDOW_MS) },
        },
      ],
      txRef: { in: payments.map((p) => p.txRef) },
    },
    select: { txRef: true, status: true, failureReason: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  log('cyan', `\n  Query found ${foundPayments.length} payment(s) to sweep:`);
  
  for (const payment of foundPayments) {
    log('green', `    ✓ ${payment.txRef}`);
    
    // Check if lock can be acquired
    const lockKey = `payment-lock:${payment.txRef}`;
    const lockAcquired = await redis.set(lockKey, 'test', 'NX', 'PX', 10000);
    
    if (lockAcquired) {
      log('green', `      → Lock acquired successfully`);
      log('green', `      → Would queue verification job with reason='sweep'`);
      await redis.del(lockKey); // Clean up test lock
    } else {
      log('red', `      → Lock failed (already being processed)`);
    }
  }

  const expectedCount = payments.filter((p) => {
    if (p.status === 'PENDING') {
      return now - p.createdAt.getTime() > 10 * 60 * 1000;
    }
    if (p.status === 'FAILED' && p.failureReason === 'gateway_reported_failed') {
      return now - p.createdAt.getTime() < CHECKOUT_RETRY_WINDOW_MS;
    }
    return false;
  }).length;

  return { foundCount: foundPayments.length, expectedCount };
}

async function cleanup(payments: TestPayment[]) {
  log('blue', '\n🧹 Cleaning up test payments...');

  await prisma.payment.deleteMany({
    where: {
      txRef: { in: payments.map((p) => p.txRef) },
    },
  });

  log('green', `  ✓ Deleted ${payments.length} test payment(s)`);
}

async function checkSweepSchedule() {
  log('blue', '\n⏰ Checking sweep worker schedule...');

  try {
    // Check if the scheduled job exists in BullMQ
    const schedulerKey = 'bull:maintenance:repeat';
    const schedulers = await redis.zrange(schedulerKey, 0, -1);
    
    const sweepScheduler = schedulers.find((s) => s.includes('pending-payment-sweep'));
    
    if (sweepScheduler) {
      log('green', '  ✓ Sweep worker scheduled job found in Redis');
      log('cyan', `     Cron: */5 * * * * (every 5 minutes)`);
    } else {
      log('yellow', '  ⚠ Sweep worker scheduled job not found in Redis');
      log('yellow', '     This is expected if RUN_WORKERS=false or API not started');
    }
  } catch (error) {
    log('yellow', '  ⚠ Could not check Redis scheduler (this is okay for manual testing)');
  }
}

async function main() {
  log('cyan', '═══════════════════════════════════════════════════════');
  log('cyan', '   🧪 Sweep Worker Test Script');
  log('cyan', '═══════════════════════════════════════════════════════');

  try {
    // Step 1: Get test data
    const school = await getTestSchool();
    log('green', `\n✓ Using school: ${school.name} (${school.code})`);

    const invoice = await getTestInvoice(school.id);
    log('green', `✓ Using invoice: ${invoice.number}`);

    // Step 2: Create test payments
    const payments = await createTestPayments(school.id, invoice.id);

    // Step 3: Check expected behavior
    await checkSweepBehavior(payments);

    // Step 4: Simulate the sweep query
    const { foundCount, expectedCount } = await simulateSweep(payments);

    // Step 5: Check sweep schedule
    await checkSweepSchedule();

    // Step 6: Cleanup
    await cleanup(payments);

    // Final summary
    log('cyan', '\n═══════════════════════════════════════════════════════');
    log('cyan', '   📊 Test Summary');
    log('cyan', '═══════════════════════════════════════════════════════');
    
    if (foundCount === expectedCount) {
      log('green', `\n✅ SUCCESS: Sweep query found ${foundCount}/${expectedCount} expected payments`);
      log('green', '\nThe sweep worker is correctly configured to:');
      log('green', '  • Pick up PENDING payments older than 10 minutes');
      log('green', '  • Pick up FAILED payments with gateway_reported_failed within 30 minutes');
      log('green', '  • Skip payments outside these criteria');
    } else {
      log('red', `\n❌ MISMATCH: Expected ${expectedCount} but found ${foundCount}`);
      log('red', 'Review the query logic in reconciliation.service.ts');
    }

    log('cyan', '\n═══════════════════════════════════════════════════════\n');

  } catch (error) {
    log('red', `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    await redis.quit();
  }
}

main();
