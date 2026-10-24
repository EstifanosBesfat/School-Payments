const path = require('node:path');
const { createRequire } = require('node:module');
const { config } = require('dotenv');

config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const requireFromApi = createRequire(path.resolve(__dirname, '../package.json'));
const { createPrismaClient } = requireFromApi('@payment/db');

const token = 'playwright-pay';
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL before the pay browser test');
}

async function main() {
  const prisma = createPrismaClient({ connectionString });
  try {
    const school = await prisma.school.upsert({
      where: { code: 'PW' },
      update: { status: 'ACTIVE' },
      create: {
        name: 'Playwright Academy',
        code: 'PW',
        status: 'ACTIVE',
        contactEmail: 'pw@example.test',
        contactPhone: '+251911000099',
      },
    });
    const student = await prisma.student.upsert({
      where: { schoolId_code: { schoolId: school.id, code: 'PW-001' } },
      update: {},
      create: { schoolId: school.id, code: 'PW-001', firstName: 'Abebe', lastName: 'Kebede', grade: '5', section: 'A' },
    });
    const invoice = await prisma.invoice.upsert({
      where: { payToken: token },
      update: { status: 'ISSUED', paidAmount: 0, totalAmount: 10_000 },
      create: {
        schoolId: school.id,
        studentId: student.id,
        number: 'PW-2026-000001',
        billRef: 'PW-2026-000001',
        status: 'ISSUED',
        totalAmount: 10_000,
        paidAmount: 0,
        dueDate: new Date('2026-12-31T00:00:00.000Z'),
        payToken: token,
        lines: { create: [{ schoolId: school.id, description: 'Tuition', amount: 10_000, position: 0 }] },
      },
    });
    if (invoice.totalAmount !== 10_000) {
      await prisma.invoice.update({ where: { id: invoice.id }, data: { totalAmount: 10_000, paidAmount: 0, status: 'ISSUED' } });
    }
    process.stdout.write(token);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
