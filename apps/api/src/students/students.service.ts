import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@payment/db';
import type { CreateStudentInput, GuardianInput } from '@payment/shared';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../common/principal';
import { PrismaService, type Tx } from '../prisma/prisma.service';

const IMPORT_CHUNK = 100;

export interface StudentListFilter {
  page: number;
  pageSize: number;
  search?: string;
  grade?: string;
  section?: string;
  includeInactive?: boolean;
}

export interface UpdateStudentInput {
  firstName?: string;
  lastName?: string;
  grade?: string;
  section?: string | null;
  isActive?: boolean;
  guardians?: GuardianInput[];
}

const STUDENT_INCLUDE = {
  guardians: {
    include: { guardian: { select: { id: true, name: true, phone: true, email: true, language: true } } },
    orderBy: { isPrimary: 'desc' },
  },
} satisfies Prisma.StudentInclude;

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(schoolId: string, filter: StudentListFilter) {
    const where: Prisma.StudentWhereInput = { schoolId };
    if (!filter.includeInactive) where.isActive = true;
    if (filter.grade) where.grade = filter.grade;
    if (filter.section) where.section = filter.section;
    if (filter.search) {
      where.OR = [
        { code: { contains: filter.search, mode: 'insensitive' } },
        { firstName: { contains: filter.search, mode: 'insensitive' } },
        { lastName: { contains: filter.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.tenant(schoolId, async (tx) => {
      const items = await tx.student.findMany({
        where,
        include: STUDENT_INCLUDE,
        orderBy: [{ grade: 'asc' }, { section: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      });
      const total = await tx.student.count({ where });
      return { items, total, page: filter.page, pageSize: filter.pageSize };
    });
  }

  async get(schoolId: string, studentId: string) {
    const student = await this.prisma.tenant(schoolId, (tx) =>
      tx.student.findFirst({
        where: { id: studentId, schoolId },
        include: {
          ...STUDENT_INCLUDE,
          invoices: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: { id: true, number: true, term: true, status: true, totalAmount: true, paidAmount: true, dueDate: true, createdAt: true },
          },
        },
      }),
    );
    if (!student) throw new NotFoundException('Student not found');
    return student;
  }

  grades(schoolId: string) {
    return this.prisma.tenant(schoolId, async (tx) => {
      const rows = await tx.student.groupBy({
        by: ['grade', 'section'],
        where: { schoolId, isActive: true },
        _count: { _all: true },
        orderBy: [{ grade: 'asc' }, { section: 'asc' }],
      });
      return rows.map((row) => ({ grade: row.grade, section: row.section, students: row._count._all }));
    });
  }

  async create(schoolId: string, input: CreateStudentInput, principal: Principal) {
    try {
      return await this.prisma.tenant(schoolId, async (tx) => {
        const student = await tx.student.create({
          data: {
            schoolId,
            code: input.code,
            firstName: input.firstName,
            lastName: input.lastName,
            grade: input.grade,
            section: input.section,
          },
        });
        await this.linkGuardians(tx, schoolId, student.id, input.guardians);
        await this.audit.record({ schoolId, principal, action: 'student.created', entityType: 'Student', entityId: student.id, metadata: { code: student.code } }, tx);
        return tx.student.findUniqueOrThrow({ where: { id: student.id }, include: STUDENT_INCLUDE });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A student with code ${input.code} already exists`);
      }
      throw error;
    }
  }

  async update(schoolId: string, studentId: string, input: UpdateStudentInput, principal: Principal) {
    return this.prisma.tenant(schoolId, async (tx) => {
      const existing = await tx.student.findFirst({ where: { id: studentId, schoolId } });
      if (!existing) throw new NotFoundException('Student not found');
      await tx.student.update({
        where: { id: studentId },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          grade: input.grade,
          section: input.section,
          isActive: input.isActive,
        },
      });
      if (input.guardians) {
        await tx.studentGuardian.deleteMany({ where: { studentId, schoolId } });
        await this.linkGuardians(tx, schoolId, studentId, input.guardians);
      }
      const { guardians, ...changes } = input;
      await this.audit.record(
        { schoolId, principal, action: 'student.updated', entityType: 'Student', entityId: studentId, metadata: { ...changes, guardiansReplaced: Boolean(guardians) } },
        tx,
      );
      return tx.student.findUniqueOrThrow({ where: { id: studentId }, include: STUDENT_INCLUDE });
    });
  }

  /** Upserts students by code (and guardians by phone) so a roster export can be re-imported safely. */
  async import(schoolId: string, students: CreateStudentInput[], principal: Principal) {
    let created = 0;
    let updated = 0;
    for (let index = 0; index < students.length; index += IMPORT_CHUNK) {
      const chunk = students.slice(index, index + IMPORT_CHUNK);
      const result = await this.prisma.tenant(
        schoolId,
        async (tx) => {
          let chunkCreated = 0;
          let chunkUpdated = 0;
          for (const input of chunk) {
            const existing = await tx.student.findUnique({ where: { schoolId_code: { schoolId, code: input.code } }, select: { id: true } });
            const student = await tx.student.upsert({
              where: { schoolId_code: { schoolId, code: input.code } },
              create: { schoolId, code: input.code, firstName: input.firstName, lastName: input.lastName, grade: input.grade, section: input.section },
              update: { firstName: input.firstName, lastName: input.lastName, grade: input.grade, section: input.section ?? null, isActive: true },
            });
            await tx.studentGuardian.deleteMany({ where: { studentId: student.id, schoolId } });
            await this.linkGuardians(tx, schoolId, student.id, input.guardians);
            if (existing) chunkUpdated += 1;
            else chunkCreated += 1;
          }
          return { chunkCreated, chunkUpdated };
        },
        { timeout: 60_000 },
      );
      created += result.chunkCreated;
      updated += result.chunkUpdated;
    }
    await this.audit.record({ schoolId, principal, action: 'student.imported', entityType: 'Student', metadata: { created, updated } });
    return { created, updated, total: students.length };
  }

  private async linkGuardians(tx: Tx, schoolId: string, studentId: string, guardians: GuardianInput[]): Promise<void> {
    const primaryPhone = (guardians.find((guardian) => guardian.isPrimary) ?? guardians[0])?.phone;
    const seen = new Set<string>();
    for (const input of guardians) {
      if (seen.has(input.phone)) continue;
      seen.add(input.phone);
      const guardian = await tx.guardian.upsert({
        where: { schoolId_phone: { schoolId, phone: input.phone } },
        create: { schoolId, name: input.name, phone: input.phone, email: input.email, language: input.language },
        update: { name: input.name, email: input.email, language: input.language },
      });
      await tx.studentGuardian.create({
        data: { schoolId, studentId, guardianId: guardian.id, relationship: input.relationship, isPrimary: input.phone === primaryPhone },
      });
    }
  }
}
