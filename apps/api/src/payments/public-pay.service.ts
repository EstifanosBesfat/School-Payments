import { Injectable, NotFoundException } from '@nestjs/common';
import { maskPhone, shortVerificationCode } from '@payment/shared';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, QUEUES, type VerifyPaymentJob } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { shouldRecheckFailedPayment } from './payments.service';

/** Pending checkout is confirmed quickly. A declined card is rechecked on a slower cadence. */
const PENDING_POLL_BUCKET_MS = 15_000;
const FAILED_RECHECK_BUCKET_MS = 60_000;

/**
 * Data shown on the public pay page. The pay token in the SMS link is a 256-bit secret, so
 * whoever holds the link can see this invoice and its receipts - nothing else.
 */
@Injectable()
export class PublicPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  private async load(payToken: string) {
    const invoice = await this.prisma.db.invoice.findUnique({
      where: { payToken },
      include: {
        school: { select: { name: true, code: true, logoUrl: true, status: true, city: true } },
        student: { select: { firstName: true, lastName: true, code: true, grade: true, section: true } },
        lines: { orderBy: { position: 'asc' }, select: { description: true, amount: true } },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { txRef: true, status: true, amount: true, method: true, createdAt: true, succeededAt: true },
        },
        receipts: {
          orderBy: { issuedAt: 'desc' },
          select: { id: true, receiptNo: true, payloadHash: true, issuedAt: true, pdfKey: true },
        },
      },
    });
    if (!invoice) throw new NotFoundException('This payment link is not valid');
    return invoice;
  }

  async view(payToken: string) {
    const invoice = await this.load(payToken);
    return {
      school: invoice.school,
      student: {
        name: `${invoice.student.firstName} ${invoice.student.lastName.charAt(0)}.`,
        code: invoice.student.code,
        grade: invoice.student.grade,
        section: invoice.student.section,
      },
      invoice: {
        number: invoice.number,
        term: invoice.term,
        status: invoice.status,
        currency: invoice.currency,
        totalAmount: invoice.totalAmount,
        paidAmount: invoice.paidAmount,
        balance: invoice.totalAmount - invoice.paidAmount,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        lines: invoice.lines,
      },
      payments: invoice.payments,
      receipts: invoice.receipts.map((receipt) => ({
        id: receipt.id,
        receiptNo: receipt.receiptNo,
        verificationCode: shortVerificationCode(receipt.payloadHash),
        issuedAt: receipt.issuedAt,
        pdfReady: Boolean(receipt.pdfKey),
      })),
      acceptingPayments: invoice.school.status === 'ACTIVE' && (invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID'),
    };
  }

  /** Return page polling. Pending and recently declined attempts trigger a server-side verify. */
  async status(payToken: string, txRef: string) {
    const invoice = await this.load(payToken);
    const payment = await this.prisma.db.payment.findFirst({
      where: { txRef, invoiceId: invoice.id },
      include: { receipt: { select: { id: true, receiptNo: true, payloadHash: true, pdfKey: true } } },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    const rechecking = payment.status === 'PENDING' || shouldRecheckFailedPayment(payment);
    if (rechecking) {
      const bucketMs = payment.status === 'FAILED' ? FAILED_RECHECK_BUCKET_MS : PENDING_POLL_BUCKET_MS;
      await this.queues.add<VerifyPaymentJob>(QUEUES.payments, JOBS.verifyPayment, { txRef, reason: 'return' }, {
        jobId: `poll-${txRef}-${Math.floor(Date.now() / bucketMs)}`,
      });
    }
    return {
      rechecking,
      invoiceStatus: invoice.status,
      payment: {
        txRef: payment.txRef,
        status: payment.status,
        amount: payment.amount,
        method: payment.method,
        payer: maskPhone(payment.payerPhone),
      },
      receipt: payment.receipt
        ? {
            id: payment.receipt.id,
            receiptNo: payment.receipt.receiptNo,
            verificationCode: shortVerificationCode(payment.receipt.payloadHash),
            pdfReady: Boolean(payment.receipt.pdfKey),
          }
        : null,
    };
  }
}
