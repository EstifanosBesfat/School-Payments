import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { Prisma, Receipt } from '@payment/db';
import {
  encodeReceiptQr,
  maskPhone,
  RECEIPT_PAYLOAD_VERSION,
  type ReceiptPayload,
  receiptPayloadHash,
  santimToEtbString,
  shortVerificationCode,
  verifyReceiptSignature,
} from '@payment/shared';
import type { Job } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { safeEqual } from '../common/crypto.util';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { OutboundWebhooksService } from '../integrations/outbound-webhooks.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { type IssueReceiptJob, JOBS, QUEUES, type RenderReceiptPdfJob } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { STORAGE_DRIVER, type StorageDriver } from '../storage/storage-driver.interface';
import { buildOfflineVerifierHtml } from './offline-verifier';
import { renderReceiptPdf } from './receipt-pdf';
import { ReceiptSigner } from './receipt-signer';

function normalizeCode(code: string): string {
  const compact = code.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface ChainCheckResult {
  receipts: number;
  valid: boolean;
  problems: { receiptNo: string; problem: 'hash_mismatch' | 'broken_link' | 'bad_signature' | 'sequence_gap' }[];
}

@Injectable()
export class ReceiptsService implements OnModuleInit {
  private readonly logger = new Logger(ReceiptsService.name);
  readonly signer: ReceiptSigner;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
    private readonly outbound: OutboundWebhooksService,
    private readonly notifications: NotificationsService,
  ) {
    this.signer = new ReceiptSigner({
      keyId: env.RECEIPT_SIGNING_KEY_ID,
      privateKeyPemBase64: env.RECEIPT_SIGNING_PRIVATE_KEY,
      publicKey: env.RECEIPT_SIGNING_PUBLIC_KEY,
      additionalPublicKeys: env.RECEIPT_ADDITIONAL_PUBLIC_KEYS,
    });
  }

  onModuleInit(): void {
    this.queues.register(QUEUES.receipts, JOBS.issueReceipt, (job: Job<IssueReceiptJob>) => this.issue(job.data.paymentId));
    this.queues.register(QUEUES.receipts, JOBS.renderReceiptPdf, (job: Job<RenderReceiptPdfJob>) => this.render(job.data.receiptId));
  }

  get verifyUrl(): string {
    return `${this.env.WEB_URL}/verify`;
  }

  /**
   * Issues the receipt for a succeeded payment exactly once. The school row lock serializes
   * receipt numbering and the hash chain (each receipt commits to the previous one's hash).
   */
  async issue(paymentId: string): Promise<Receipt> {
    const lookup = await this.prisma.db.payment.findUnique({ where: { id: paymentId }, select: { schoolId: true } });
    if (!lookup) throw new NotFoundException(`Payment ${paymentId} not found`);

    const { receipt, created } = await this.prisma.tenant(
      lookup.schoolId,
      async (tx) => {
        const existing = await tx.receipt.findUnique({ where: { paymentId } });
        if (existing) return { receipt: existing, created: false };
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { invoice: { include: { lines: { orderBy: { position: 'asc' } }, student: true } } },
        });
        if (payment.status !== 'SUCCEEDED') throw new Error(`Payment ${paymentId} is ${payment.status}; receipts are only issued for succeeded payments`);

        await tx.$queryRaw`SELECT id FROM "School" WHERE id = ${payment.schoolId} FOR UPDATE`;
        const school = await tx.school.update({
          where: { id: payment.schoolId },
          data: { receiptSeq: { increment: 1 } },
          select: { id: true, name: true, code: true, receiptSeq: true, lastReceiptHash: true },
        });
        const receiptNo = `${school.code}-R-${String(school.receiptSeq).padStart(7, '0')}`;
        const { invoice } = payment;
        const fullyPaysInvoice = payment.amount === invoice.totalAmount;
        const items = fullyPaysInvoice
          ? invoice.lines.map((line) => ({ label: line.description, amount: line.amount }))
          : [{ label: `Payment towards invoice ${invoice.number}`, amount: payment.amount }];
        const issuedAt = new Date();
        const payload: ReceiptPayload = {
          v: RECEIPT_PAYLOAD_VERSION,
          kid: this.signer.keyId,
          receiptNo,
          school: { id: school.id, name: school.name, code: school.code },
          student: { name: `${invoice.student.firstName} ${invoice.student.lastName}`, code: invoice.student.code, grade: [invoice.student.grade, invoice.student.section].filter(Boolean).join(' ') },
          payer: { name: payment.payerName, phone: maskPhone(payment.payerPhone) },
          invoiceNo: invoice.number,
          items,
          total: payment.amount,
          currency: 'ETB',
          method: payment.method ?? 'unknown',
          gateway: payment.gateway,
          gatewayRef: payment.gatewayReference ?? payment.txRef,
          txRef: payment.txRef,
          paidAt: (payment.succeededAt ?? issuedAt).toISOString(),
          issuedAt: issuedAt.toISOString(),
          prevHash: school.lastReceiptHash,
        };
        const signed = await this.signer.sign(payload);
        const receipt = await tx.receipt.create({
          data: {
            schoolId: school.id,
            paymentId: payment.id,
            invoiceId: invoice.id,
            receiptNo,
            sequence: school.receiptSeq,
            payload: payload as unknown as Prisma.InputJsonObject,
            payloadHash: signed.payloadHash,
            prevHash: school.lastReceiptHash,
            signature: signed.signature,
            keyId: this.signer.keyId,
            issuedAt,
          },
        });
        await tx.school.update({ where: { id: school.id }, data: { lastReceiptHash: signed.payloadHash } });
        await this.audit.record(
          { schoolId: school.id, actorType: 'system', actorId: 'receipts', action: 'receipt.issued', entityType: 'Receipt', entityId: receipt.id, metadata: { receiptNo, paymentId, hash: signed.payloadHash } },
          tx,
        );
        return { receipt, created: true };
      },
      { isolationLevel: 'ReadCommitted', timeout: 20_000 },
    );

    if (created) {
      await this.queues.add<RenderReceiptPdfJob>(QUEUES.receipts, JOBS.renderReceiptPdf, { receiptId: receipt.id }, { jobId: `pdf-${receipt.id}` });
      await this.outbound.emit(receipt.schoolId, 'receipt.issued', {
        receiptId: receipt.id,
        receiptNo: receipt.receiptNo,
        paymentId: receipt.paymentId,
        invoiceId: receipt.invoiceId,
        payloadHash: receipt.payloadHash,
        verificationCode: shortVerificationCode(receipt.payloadHash),
      });
    }
    return receipt;
  }

  /** Renders and stores the PDF, then notifies the payer (the email carries the PDF). */
  async render(receiptId: string): Promise<string> {
    const receipt = await this.prisma.db.receipt.findUnique({ where: { id: receiptId } });
    if (!receipt) throw new NotFoundException(`Receipt ${receiptId} not found`);
    const key = receipt.pdfKey ?? `receipts/${receipt.schoolId}/${receipt.receiptNo}.pdf`;
    if (!receipt.pdfKey || !(await this.storage.exists(key))) {
      const payload = receipt.payload as unknown as ReceiptPayload;
      const pdf = await renderReceiptPdf({
        payload,
        payloadHash: receipt.payloadHash,
        qrContent: encodeReceiptQr(this.verifyUrl, { payload, signature: receipt.signature }),
        verifyUrl: this.verifyUrl,
      });
      await this.storage.put(key, pdf, 'application/pdf');
      if (!receipt.pdfKey) {
        await this.prisma.tenant(receipt.schoolId, (tx) => tx.receipt.update({ where: { id: receipt.id }, data: { pdfKey: key } }));
        await this.notifications.receiptIssued(receipt.id);
      }
    }
    return key;
  }

  async pdf(receipt: Receipt): Promise<Buffer> {
    const key = receipt.pdfKey && (await this.storage.exists(receipt.pdfKey)) ? receipt.pdfKey : await this.render(receipt.id);
    return this.storage.get(key);
  }

  publicKeys() {
    return { keys: this.signer.publicKeys(), algorithm: 'Ed25519', encoding: 'base64url-raw', currentKeyId: this.signer.keyId };
  }

  offlineVerifierHtml(): string {
    return buildOfflineVerifierHtml(this.signer.publicKeys(), new Date());
  }

  qrContent(receipt: Receipt): string {
    return encodeReceiptQr(this.verifyUrl, { payload: receipt.payload as unknown as ReceiptPayload, signature: receipt.signature });
  }

  /** Public lookup by receipt number + the 8-character code printed on it / sent by SMS. */
  async lookup(receiptNo: string, code: string) {
    const receipt = await this.findByNumberAndCode(receiptNo, code);
    const payload = receipt.payload as unknown as ReceiptPayload;
    const verification = await verifyReceiptSignature(this.signer.publicKeys(), { payload, signature: receipt.signature });
    const payment = await this.prisma.db.payment.findUnique({ where: { id: receipt.paymentId }, select: { status: true } });
    return {
      receiptNo: receipt.receiptNo,
      payload,
      signature: receipt.signature,
      keyId: receipt.keyId,
      payloadHash: receipt.payloadHash,
      verificationCode: shortVerificationCode(receipt.payloadHash),
      signatureValid: verification.valid,
      paymentStatus: payment?.status ?? 'UNKNOWN',
      qr: this.qrContent(receipt),
    };
  }

  async findByNumberAndCode(receiptNo: string, code: string): Promise<Receipt> {
    const receipt = await this.prisma.db.receipt.findFirst({ where: { receiptNo: receiptNo.trim().toUpperCase() } });
    if (!receipt || !safeEqual(shortVerificationCode(receipt.payloadHash), normalizeCode(code))) {
      throw new NotFoundException('No receipt matches this number and code');
    }
    return receipt;
  }

  async receiptForPayToken(payToken: string, receiptId: string): Promise<Receipt> {
    const receipt = await this.prisma.db.receipt.findFirst({ where: { id: receiptId, invoice: { payToken } } });
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }

  list(schoolId: string, filter: { page: number; pageSize: number; search?: string; from?: Date; to?: Date }) {
    const where: Prisma.ReceiptWhereInput = { schoolId };
    if (filter.from || filter.to) where.issuedAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) };
    if (filter.search) {
      where.OR = [
        { receiptNo: { contains: filter.search, mode: 'insensitive' } },
        { invoice: { number: { contains: filter.search, mode: 'insensitive' } } },
        { invoice: { student: { code: { contains: filter.search, mode: 'insensitive' } } } },
        { invoice: { student: { lastName: { contains: filter.search, mode: 'insensitive' } } } },
      ];
    }
    return this.prisma.tenant(schoolId, async (tx) => {
      const rows = await tx.receipt.findMany({
        where,
        orderBy: { sequence: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        include: {
          payment: { select: { amount: true, method: true, payerName: true, status: true } },
          invoice: { select: { number: true, student: { select: { code: true, firstName: true, lastName: true } } } },
        },
      });
      const total = await tx.receipt.count({ where });
      const items = rows.map(({ payload: _payload, signature: _signature, ...row }) => ({ ...row, verificationCode: shortVerificationCode(row.payloadHash) }));
      return { items, total, page: filter.page, pageSize: filter.pageSize };
    });
  }

  async getForSchool(schoolId: string, receiptId: string) {
    const receipt = await this.prisma.tenant(schoolId, (tx) => tx.receipt.findFirst({ where: { id: receiptId, schoolId } }));
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }

  async exportCsv(schoolId: string, from?: Date, to?: Date): Promise<string> {
    const rows = await this.prisma.tenant(
      schoolId,
      (tx) =>
        tx.receipt.findMany({
          where: { schoolId, ...(from || to ? { issuedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
          orderBy: { sequence: 'asc' },
          include: {
            payment: { select: { amount: true, method: true, gateway: true, gatewayReference: true, txRef: true, payerName: true, status: true, gatewayFee: true, platformFee: true } },
            invoice: { select: { number: true, term: true, student: { select: { code: true, firstName: true, lastName: true, grade: true, section: true } } } },
          },
        }),
      { timeout: 60_000 },
    );
    const header = ['receipt_no', 'issued_at', 'student_code', 'student_name', 'grade', 'section', 'invoice_no', 'term', 'amount_etb', 'gateway_fee_etb', 'platform_fee_etb', 'method', 'gateway', 'gateway_reference', 'tx_ref', 'payer', 'payment_status', 'verification_code'];
    const lines = rows.map((row) =>
      [
        row.receiptNo,
        row.issuedAt.toISOString(),
        row.invoice.student.code,
        `${row.invoice.student.firstName} ${row.invoice.student.lastName}`,
        row.invoice.student.grade,
        row.invoice.student.section,
        row.invoice.number,
        row.invoice.term,
        santimToEtbString(row.payment.amount),
        row.payment.gatewayFee === null ? '' : santimToEtbString(row.payment.gatewayFee),
        row.payment.platformFee === null ? '' : santimToEtbString(row.payment.platformFee),
        row.payment.method,
        row.payment.gateway,
        row.payment.gatewayReference,
        row.payment.txRef,
        row.payment.payerName,
        row.payment.status,
        shortVerificationCode(row.payloadHash),
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** Recomputes every hash, link and signature of a school's receipt chain. */
  async verifyChain(schoolId: string): Promise<ChainCheckResult> {
    const receipts = await this.prisma.tenant(schoolId, (tx) => tx.receipt.findMany({ where: { schoolId }, orderBy: { sequence: 'asc' } }), { timeout: 120_000 });
    const keys = this.signer.publicKeys();
    const problems: ChainCheckResult['problems'] = [];
    let previousHash: string | null = null;
    let expectedSequence = 1;
    for (const receipt of receipts) {
      const payload = receipt.payload as unknown as ReceiptPayload;
      if (receipt.sequence !== expectedSequence) problems.push({ receiptNo: receipt.receiptNo, problem: 'sequence_gap' });
      expectedSequence = receipt.sequence + 1;
      if ((await receiptPayloadHash(payload)) !== receipt.payloadHash) problems.push({ receiptNo: receipt.receiptNo, problem: 'hash_mismatch' });
      if (receipt.prevHash !== previousHash || payload.prevHash !== previousHash) problems.push({ receiptNo: receipt.receiptNo, problem: 'broken_link' });
      if (!(await verifyReceiptSignature(keys, { payload, signature: receipt.signature })).valid) problems.push({ receiptNo: receipt.receiptNo, problem: 'bad_signature' });
      previousHash = receipt.payloadHash;
    }
    if (problems.length > 0) this.logger.error(`Receipt chain check failed for school ${schoolId}: ${problems.length} problems`);
    return { receipts: receipts.length, valid: problems.length === 0, problems };
  }
}
