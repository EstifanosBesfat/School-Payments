/**
 * Test script for Chapa CBE Birr payment flow.
 * Creates a school with Chapa subaccount, a student, and an unpaid invoice.
 * Prints the payment link to test CBE Birr via Chapa's hosted checkout.
 *
 * Usage:
 *   node apps/api/scripts/test-chapa-cbe.cjs
 *
 * The script will print a payment URL like:
 *   http://localhost:3000/pay/XXXXXXXX
 *
 * Open this URL in your browser, enter payer details, and you'll be redirected
 * to Chapa's hosted checkout where you can select CBE Birr (with dynamic code generation).
 */

const path = require('node:path');
const { createRequire } = require('node:module');
const { config } = require('dotenv');

config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const requireFromApi = createRequire(path.resolve(__dirname, '../package.json'));
const { createPrismaClient } = requireFromApi('@payment/db');

const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL or MIGRATION_DATABASE_URL environment variable is required');
  process.exit(1);
}

const webUrl = process.env.WEB_URL || 'http://localhost:3000';

async function main() {
  const prisma = createPrismaClient({ connectionString });

  try {
    console.log('🏫 Creating test school with Chapa integration...');

    // Create or update school
    const school = await prisma.school.upsert({
      where: { code: 'CHAPA-TEST' },
      update: {
        status: 'ACTIVE',
        chapaSubaccountId: process.env.CHAPA_TEST_SUBACCOUNT_ID || 'test-subaccount-id',
      },
      create: {
        name: 'Chapa Test School',
        code: 'CHAPA-TEST',
        status: 'ACTIVE',
        contactEmail: 'test@chapatest.et',
        contactPhone: '+251911000001',
        city: 'Addis Ababa',
        chapaSubaccountId: process.env.CHAPA_TEST_SUBACCOUNT_ID || 'test-subaccount-id',
      },
    });

    console.log(`✓ School created: ${school.name} (${school.code})`);

    // Create or update student
    const student = await prisma.student.upsert({
      where: { schoolId_code: { schoolId: school.id, code: 'STU-001' } },
      update: {},
      create: {
        schoolId: school.id,
        code: 'STU-001',
        firstName: 'Abebe',
        lastName: 'Bekele',
        grade: '10',
        section: 'A',
      },
    });

    console.log(`✓ Student created: ${student.firstName} ${student.lastName} (${student.code})`);

    // Create guardian
    await prisma.guardian.upsert({
      where: { schoolId_studentId_phone: { schoolId: school.id, studentId: student.id, phone: '+251911223344' } },
      update: {},
      create: {
        schoolId: school.id,
        studentId: student.id,
        name: 'Parent Guardian',
        phone: '+251911223344',
        email: 'parent@example.com',
        relationship: 'Parent',
        language: 'am',
        isPrimary: true,
      },
    });

    console.log('✓ Guardian created');

    // Generate a unique bill reference
    const timestamp = Date.now().toString(36).toUpperCase();
    const billRef = `CHAPA-TEST-${timestamp}`;
    const invoiceNumber = `INV-${timestamp}`;

    // Create invoice
    const invoice = await prisma.invoice.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        number: invoiceNumber,
        billRef: billRef,
        status: 'ISSUED',
        currency: 'ETB',
        totalAmount: 250_000, // ETB 2,500.00
        paidAmount: 0,
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        term: '2026/2027 - Semester 1',
        lines: {
          create: [
            {
              schoolId: school.id,
              description: 'Tuition Fee',
              amount: 200_000, // ETB 2,000.00
              position: 0,
            },
            {
              schoolId: school.id,
              description: 'Library Fee',
              amount: 30_000, // ETB 300.00
              position: 1,
            },
            {
              schoolId: school.id,
              description: 'Sports Fee',
              amount: 20_000, // ETB 200.00
              position: 2,
            },
          ],
        },
      },
      include: {
        lines: true,
      },
    });

    console.log(`✓ Invoice created: ${invoice.number}`);
    console.log(`  Amount: ETB ${(invoice.totalAmount / 100).toFixed(2)}`);
    console.log(`  Due date: ${invoice.dueDate.toISOString().slice(0, 10)}`);
    console.log(`  Lines: ${invoice.lines.length} items`);

    // Print payment URL
    const paymentUrl = `${webUrl}/pay/${invoice.payToken}`;
    console.log('\n✨ Payment link ready!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`\n  ${paymentUrl}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n📝 Testing instructions:');
    console.log('  1. Open the URL above in your browser');
    console.log('  2. Fill in payer name, phone, and email');
    console.log('  3. Click "Pay" - you will be redirected to Chapa checkout');
    console.log('  4. On Chapa\'s page, select "CBE Birr" payment method');
    console.log('  5. Complete the payment using CBE\'s dynamic code generation');
    console.log('  6. You will be redirected back with payment confirmation\n');

    // Print some debug info
    console.log('🔧 Configuration:');
    console.log(`  Gateway: ${process.env.PAYMENT_GATEWAY || 'not set'}`);
    console.log(`  Chapa URL: ${process.env.CHAPA_BASE_URL || 'not set'}`);
    console.log(`  Subaccount: ${school.chapaSubaccountId || 'none'}`);
    console.log('');

  } catch (error) {
    console.error('❌ Error creating test data:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
