import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { InvoiceStatus, Prisma } from '@payment/db';
import { type BulkInvoiceInput, type CreateInvoiceInput, sumSantim } from '@payment/shared';
import { AuditService } from '../audit/audit.service';
import { randomToken } from '../common/crypto.util';
import type { Principal } from '../common/principal';
import { OutboundWebhooksService } from '../integrations/outbound-webhooks.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';

export interface InvoiceListFilter {
  page: number;
  pageSize: number;
  status?: InvoiceStatus;
  studentId?: string;
  term?: string;
  overdue?: boolean;
  search?: string;
}

interface InvoiceDraft {
  studentId: string;
  term?: string;
  dueDate: string;
  lines: { feeItemId?: string; description: string; amount: number }[];
}

const OPEN_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID'];

function parseDueDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid due date');
  return date;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly outbound: OutboundWebhooksService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(schoolId: string, input: CreateInvoiceInput, principal: Principal) {
    const feeItemIds = input.lines.map((line) => line.feeItemId).filter((id): id is string => Boolean(id));
    const invoice = await this.prisma.tenant(schoolId, async (tx) => {
      const student = await tx.student.findFirst({ where: { id: input.studentId, schoolId, isActive: true }, select: { id: true } });
      if (!student) throw new NotFoundException('Student not found');
      if (feeItemIds.length > 0) {
        const found = await tx.feeItem.count({ where: { schoolId, id: { in: feeItemIds } } });
        if (found !== new Set(feeItemIds).size) throw new BadRequestException('Unknown fee item');
      }
      return this.issue(tx, schoolId, input, principal);
    });
    await this.afterIssue(schoolId, [invoice.id], input.notify);
    return this.get(schoolId, invoice.id);
  }

  /** One invoice per active student in a grade (optionally a section). Students already billed for the term are skipped. */
  async createBulk(schoolId: string, input: BulkInvoiceInput, principal: Principal) {
    const { students, feeItems } = await this.prisma.tenant(schoolId, async (tx) => {
      const feeItems = await tx.feeItem.findMany({ where: { schoolId, id: { in: input.feeItemIds }, isActive: true } });
      if (feeItems.length !== new Set(input.feeItemIds).size) throw new BadRequestException('Unknown or inactive fee item');
      const students = await tx.student.findMany({
        where: { schoolId, isActive: true, grade: input.grade, ...(input.section ? { section: input.section } : {}) },
        select: { id: true, invoices: input.term ? { where: { term: input.term, status: { not: 'CANCELLED' } }, select: { id: true }, take: 1 } : false },
      });
      return { students, feeItems };
    });
    if (students.length === 0) throw new BadRequestException('No active students in this class');

    const lines = input.feeItemIds.map((id) => {
      const item = feeItems.find((feeItem) => feeItem.id === id);
      if (!item) throw new BadRequestException('Unknown fee item');
      return { feeItemId: item.id, description: item.name, amount: item.amount };
    });
    const createdIds: string[] = [];
    let skipped = 0;
    for (const student of students) {
      const alreadyBilled = Array.isArray(student.invoices) && student.invoices.length > 0;
      if (alreadyBilled) {
        skipped += 1;
        continue;
      }
      const invoice = await this.prisma.tenant(schoolId, (tx) =>
        this.issue(tx, schoolId, { studentId: student.id, term: input.term, dueDate: input.dueDate, lines }, principal),
      );
      createdIds.push(invoice.id);
    }
    await this.audit.record({
      schoolId,
      principal,
      action: 'invoice.bulk_created',
      entityType: 'Invoice',
      metadata: { grade: input.grade, section: input.section ?? null, term: input.term ?? null, created: createdIds.length, skipped },
    });
    await this.afterIssue(schoolId, createdIds, input.notify);
    return { created: createdIds.length, skipped, totalPerStudent: sumSantim(lines.map((line) => line.amount)) };
  }

  list(schoolId: string, filter: InvoiceListFilter) {
    const where: Prisma.InvoiceWhereInput = { schoolId };
    if (filter.status) where.status = filter.status;
    if (filter.studentId) where.studentId = filter.studentId;
    if (filter.term) where.term = filter.term;
    if (filter.overdue) {
      where.status = { in: OPEN_STATUSES };
      where.dueDate = { lt: new Date() };
    }
    if (filter.search) {
      where.OR = [
        { number: { contains: filter.search, mode: 'insensitive' } },
        { student: { code: { contains: filter.search, mode: 'insensitive' } } },
        { student: { firstName: { contains: filter.search, mode: 'insensitive' } } },
        { student: { lastName: { contains: filter.search, mode: 'insensitive' } } },
      ];
    }
    return this.prisma.tenant(schoolId, async (tx) => {
      const items = await tx.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        include: { student: { select: { id: true, code: true, firstName: true, lastName: true, grade: true, section: true } } },
      });
      const total = await tx.invoice.count({ where });
      return { items, total, page: filter.page, pageSize: filter.pageSize };
    });
  }

  async get(schoolId: string, invoiceId: string) {
    const invoice = await this.prisma.tenant(schoolId, (tx) =>
      tx.invoice.findFirst({
        where: { id: invoiceId, schoolId },
        include: {
          student: { select: { id: true, code: true, firstName: true, lastName: true, grade: true, section: true } },
          lines: { orderBy: { position: 'asc' } },
          payments: {
            orderBy: { createdAt: 'desc' },
            select: { id: true, txRef: true, status: true, amount: true, method: true, payerName: true, createdAt: true, succeededAt: true, reviewReason: true },
          },
          receipts: { select: { id: true, receiptNo: true, issuedAt: true } },
        },
      }),
    );
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async cancel(schoolId: string, invoiceId: string, reason: string, principal: Principal) {
    await this.prisma.tenant(schoolId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND "schoolId" = ${schoolId} FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, schoolId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'ISSUED' || invoice.paidAmount > 0) {
        throw new BadRequestException('Only unpaid issued invoices can be cancelled; refund paid invoices instead');
      }
      const pending = await tx.payment.count({ where: { invoiceId, status: 'PENDING' } });
      if (pending > 0) throw new BadRequestException('A payment is in progress for this invoice; try again once it completes');
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await this.ledger.invoiceCancelled(tx, schoolId, invoiceId, invoice.totalAmount, `Invoice ${invoice.number} cancelled: ${reason}`);
      await this.audit.record({ schoolId, principal, action: 'invoice.cancelled', entityType: 'Invoice', entityId: invoiceId, metadata: { reason, number: invoice.number } }, tx);
    });
    return this.get(schoolId, invoiceId);
  }

  async remind(schoolId: string, invoiceId: string, principal: Principal) {
    const invoice = await this.prisma.tenant(schoolId, (tx) => tx.invoice.findFirst({ where: { id: invoiceId, schoolId }, select: { id: true, status: true } }));
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!OPEN_STATUSES.includes(invoice.status)) throw new BadRequestException('Only unpaid invoices can be reminded');
    const sent = await this.notifications.invoiceReminder(invoiceId);
    await this.audit.record({ schoolId, principal, action: 'invoice.reminded', entityType: 'Invoice', entityId: invoiceId, metadata: { messages: sent } });
    return { messages: sent };
  }

  private async issue(tx: Tx, schoolId: string, draft: InvoiceDraft, principal: Principal) {
    const school = await tx.school.update({
      where: { id: schoolId },
      data: { invoiceSeq: { increment: 1 } },
      select: { code: true, invoiceSeq: true, status: true },
    });
    if (school.status === 'SUSPENDED') throw new BadRequestException('This school is suspended');
    const total = sumSantim(draft.lines.map((line) => line.amount));
    const number = `${school.code}-${new Date().getUTCFullYear()}-${String(school.invoiceSeq).padStart(6, '0')}`;
    const invoice = await tx.invoice.create({
      data: {
        schoolId,
        studentId: draft.studentId,
        number,
        term: draft.term,
        status: 'ISSUED',
        totalAmount: total,
        dueDate: parseDueDate(draft.dueDate),
        payToken: randomToken(24),
        billRef: number,
        issuedAt: new Date(),
        createdById: principal.type === 'user' ? principal.userId : null,
        lines: {
          create: draft.lines.map((line, position) => ({ schoolId, feeItemId: line.feeItemId, description: line.description, amount: line.amount, position })),
        },
      },
    });
    await this.ledger.invoiceIssued(tx, schoolId, invoice.id, total, `Invoice ${number} issued`);
    await this.audit.record({ schoolId, principal, action: 'invoice.issued', entityType: 'Invoice', entityId: invoice.id, metadata: { number, total } }, tx);
    return invoice;
  }

  private async afterIssue(schoolId: string, invoiceIds: string[], notify: boolean): Promise<void> {
    for (const invoiceId of invoiceIds) {
      try {
        const invoice = await this.prisma.tenant(schoolId, (tx) =>
          tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { id: true, number: true, studentId: true, totalAmount: true, dueDate: true, term: true } }),
        );
        await this.outbound.emit(schoolId, 'invoice.created', {
          invoiceId: invoice.id,
          number: invoice.number,
          studentId: invoice.studentId,
          amount: invoice.totalAmount,
          currency: 'ETB',
          dueDate: invoice.dueDate.toISOString().slice(0, 10),
          term: invoice.term,
        });
        if (notify) await this.notifications.invoiceIssued(invoiceId);
      } catch (error) {
        this.logger.error(`Post-issue processing failed for invoice ${invoiceId}: ${(error as Error).message}`);
      }
    }
  }
}
