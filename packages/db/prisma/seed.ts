import path from 'node:path';
import { config } from 'dotenv';
import argon2 from 'argon2';
import { normalizeEthiopianPhone } from '@payment/shared';
import { createPrismaClient } from '../src';

config({ path: path.resolve(process.cwd(), '../../.env') });
config();

const connectionString = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('Set MIGRATION_DATABASE_URL (or DATABASE_URL) before seeding');
}

const prisma = createPrismaClient({ connectionString });

function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

async function main(): Promise<void> {
  const adminEmail = (process.env['SEED_PLATFORM_ADMIN_EMAIL'] ?? 'admin@platform.local').toLowerCase();
  const adminPassword = process.env['SEED_PLATFORM_ADMIN_PASSWORD'] ?? 'ChangeMe!2026';

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: 'Platform Admin',
      passwordHash: await hashPassword(adminPassword),
      role: 'PLATFORM_ADMIN',
    },
  });

  const school = await prisma.school.upsert({
    where: { code: 'DEMO' },
    update: {},
    create: {
      name: 'Addis Demo Academy',
      code: 'DEMO',
      status: 'ACTIVE',
      contactEmail: 'office@demo-academy.et',
      contactPhone: normalizeEthiopianPhone('0911000000'),
      city: 'Addis Ababa',
      smsSenderName: 'DemoAcad',
    },
  });

  const staff = [
    { email: 'principal@demo-academy.et', name: 'Demo Principal', role: 'SCHOOL_ADMIN' as const },
    { email: 'accountant@demo-academy.et', name: 'Demo Accountant', role: 'ACCOUNTANT' as const },
  ];
  for (const member of staff) {
    await prisma.user.upsert({
      where: { email: member.email },
      update: {},
      create: {
        ...member,
        schoolId: school.id,
        passwordHash: await hashPassword(adminPassword),
      },
    });
  }

  const feeItems = [
    { name: 'Tuition - Term 1', amount: 450000, description: 'First term tuition fee' },
    { name: 'Transport - Term 1', amount: 120000, description: 'School bus service' },
    { name: 'Books and Materials', amount: 65000, description: 'Textbooks and exercise books' },
  ];
  for (const item of feeItems) {
    await prisma.feeItem.upsert({
      where: { schoolId_name: { schoolId: school.id, name: item.name } },
      update: {},
      create: { ...item, schoolId: school.id },
    });
  }

  const students = [
    { code: 'DEMO-001', firstName: 'Abebe', lastName: 'Kebede', grade: '5', section: 'A', guardian: { name: 'Kebede Alemu', phone: '0912345678', language: 'am' as const } },
    { code: 'DEMO-002', firstName: 'Hanna', lastName: 'Tesfaye', grade: '5', section: 'A', guardian: { name: 'Tesfaye Girma', phone: '0923456789', language: 'en' as const } },
    { code: 'DEMO-003', firstName: 'Dawit', lastName: 'Mekonnen', grade: '6', section: 'B', guardian: { name: 'Almaz Bekele', phone: '0711223344', language: 'am' as const } },
  ];
  for (const entry of students) {
    const student = await prisma.student.upsert({
      where: { schoolId_code: { schoolId: school.id, code: entry.code } },
      update: {},
      create: {
        schoolId: school.id,
        code: entry.code,
        firstName: entry.firstName,
        lastName: entry.lastName,
        grade: entry.grade,
        section: entry.section,
      },
    });
    const phone = normalizeEthiopianPhone(entry.guardian.phone);
    const guardian = await prisma.guardian.upsert({
      where: { schoolId_phone: { schoolId: school.id, phone } },
      update: {},
      create: {
        schoolId: school.id,
        name: entry.guardian.name,
        phone,
        language: entry.guardian.language,
      },
    });
    await prisma.studentGuardian.upsert({
      where: { studentId_guardianId: { studentId: student.id, guardianId: guardian.id } },
      update: {},
      create: {
        schoolId: school.id,
        studentId: student.id,
        guardianId: guardian.id,
        relationship: 'Parent',
        isPrimary: true,
      },
    });
  }

  console.log('Seed complete.');
  console.log(`  Platform admin: ${adminEmail}`);
  console.log('  School admin:   principal@demo-academy.et');
  console.log('  Accountant:     accountant@demo-academy.et');
  console.log('  (all use SEED_PLATFORM_ADMIN_PASSWORD)');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
