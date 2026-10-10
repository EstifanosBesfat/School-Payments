import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { shortVerificationCode } from '@payment/shared';
import { InvoicesService } from '../billing/invoices.service';
import type { Principal } from '../common/principal';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';

export interface CreateInvoiceByCodeInput {
  studentCode: string;
  term?: string;
  dueDate: string;
  lines: { feeItemId?: string; description: string; amount: number }[];
  notify: boolean;
}

/**
 * Integration-friendly API for school information systems: addresses students by their school
 * code and invoices by number, and always returns the parent pay link.
 */
@Injectable()
export class PublicApiService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly receipts: ReceiptsService,
  ) {}

  private payUrl(payToken: string): string {
    return `${this.env.WEB_URL}/pay/${payToken}`;
  }

  async studentBalance(schoolId: string, code: string) {
    const student = await this.prisma.tenant(schoolId, (tx) =>
      tx.student.findUnique({
        where: { schoolId_code: { schoolId, code } },
        include: {
          invoices: {
            where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
            orderBy: { dueDate: 'asc' },
            select: { number: true, term: true, status: true, totalAmount: true, paidAmount: true, dueDate: true, payToken: true },
          },
        },
      }),
    );
    if (!student) throw new NotFoundException(`Student ${code} not found`);
    const open = student.invoices.map((invoice) => ({
      number: invoice.number,
      term: invoice.term,
      status: invoice.status,
      total: invoice.totalAmount,
      paid: invoice.paidAmount,
      balance: invoice.totalAmount - invoice.paidAmount,
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      payUrl: this.payUrl(invoice.payToken),
    }));
    return {
      student: { code: student.code, name: `${student.firstName} ${student.lastName}`, grade: student.grade, section: student.section, isActive: student.isActive },
      currency: 'ETB',
      balance: open.reduce((sum, invoice) => sum + invoice.balance, 0),
      openInvoices: open,
    };
  }

  async createInvoice(schoolId: string, input: CreateInvoiceByCodeInput, principal: Principal) {
    const student = await this.prisma.tenant(schoolId, (tx) => tx.student.findUnique({ where: { schoolId_code: { schoolId, code: input.studentCode } }, select: { id: true } }));
    if (!student) throw new NotFoundException(`Student ${input.studentCode} not found`);
    const invoice = await this.invoices.create(schoolId, { studentId: student.id, term: input.term, dueDate: input.dueDate, lines: input.lines, notify: input.notify }, principal);
    return this.invoiceView(schoolId, invoice.number);
  }

  async invoiceView(schoolId: string, number: string) {
    const invoice = await this.prisma.tenant(schoolId, (tx) =>
      tx.invoice.findUnique({
        where: { schoolId_number: { schoolId, number } },
        include: {
          student: { select: { code: true, firstName: true, lastName: true } },
          lines: { orderBy: { position: 'asc' }, select: { description: true, amount: true, feeItemId: true } },
          payments: { orderBy: { createdAt: 'desc' }, select: { txRef: true, status: true, amount: true, method: true, succeededAt: true } },
          receipts: { select: { receiptNo: true, payloadHash: true, issuedAt: true } },
        },
      }),
    );
    if (!invoice) throw new NotFoundException(`Invoice ${number} not found`);
    return {
      number: invoice.number,
      status: invoice.status,
      term: invoice.term,
      currency: invoice.currency,
      total: invoice.totalAmount,
      paid: invoice.paidAmount,
      balance: invoice.totalAmount - invoice.paidAmount,
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      student: { code: invoice.student.code, name: `${invoice.student.firstName} ${invoice.student.lastName}` },
      lines: invoice.lines,
      payments: invoice.payments,
      receipts: invoice.receipts.map((receipt) => ({ receiptNo: receipt.receiptNo, issuedAt: receipt.issuedAt, verificationCode: shortVerificationCode(receipt.payloadHash) })),
      payUrl: this.payUrl(invoice.payToken),
    };
  }

  async payment(schoolId: string, txRef: string) {
    const payment = await this.prisma.tenant(schoolId, (tx) =>
      tx.payment.findFirst({
        where: { schoolId, txRef },
        select: {
          txRef: true,
          status: true,
          amount: true,
          currency: true,
          method: true,
          gateway: true,
          gatewayReference: true,
          createdAt: true,
          succeededAt: true,
          reviewReason: true,
          invoice: { select: { number: true } },
          receipt: { select: { receiptNo: true, payloadHash: true } },
        },
      }),
    );
    if (!payment) throw new NotFoundException(`Payment ${txRef} not found`);
    const { receipt, invoice, ...rest } = payment;
    return {
      ...rest,
      invoiceNumber: invoice.number,
      receipt: receipt ? { receiptNo: receipt.receiptNo, verificationCode: shortVerificationCode(receipt.payloadHash) } : null,
    };
  }

  async receipt(schoolId: string, receiptNo: string) {
    const receipt = await this.prisma.tenant(schoolId, (tx) => tx.receipt.findUnique({ where: { schoolId_receiptNo: { schoolId, receiptNo } } }));
    if (!receipt) throw new NotFoundException(`Receipt ${receiptNo} not found`);
    return {
      receiptNo: receipt.receiptNo,
      issuedAt: receipt.issuedAt,
      keyId: receipt.keyId,
      payload: receipt.payload,
      signature: receipt.signature,
      payloadHash: receipt.payloadHash,
      prevHash: receipt.prevHash,
      verificationCode: shortVerificationCode(receipt.payloadHash),
      qr: this.receipts.qrContent(receipt),
    };
  }
}
