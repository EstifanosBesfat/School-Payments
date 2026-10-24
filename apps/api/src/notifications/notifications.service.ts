import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Language, shortVerificationCode } from '@payment/shared';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { payerMethodLabel } from '../receipts/payer-method-label';
import { EmailService } from './email/email.service';
import { SmsService } from './sms/sms.service';
import { addisDateOnly, emailTemplates, smsTemplates } from './templates';

const REMINDER_DAYS_BEFORE_DUE = 3;
const OVERDUE_REMINDER_INTERVAL_DAYS = 7;
const OVERDUE_REMINDER_MAX_AGE_DAYS = 60;
const REMINDER_BATCH = 500;
const DAY_MS = 24 * 3600 * 1000;

interface Recipient {
  guardianId: string;
  phone: string;
  language: Language;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly sms: SmsService,
    private readonly email: EmailService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queues.register(QUEUES.maintenance, JOBS.sendReminders, () => this.sendScheduledReminders());
    if (this.env.RUN_WORKERS) {
      await this.queues.schedule(QUEUES.maintenance, 'daily-fee-reminders', '0 9 * * *', JOBS.sendReminders);
    }
  }

  payLink(payToken: string): string {
    return `${this.env.WEB_URL}/pay/${payToken}`;
  }

  verifyLink(receiptNo: string, code: string): string {
    return `${this.env.WEB_URL}/verify?no=${encodeURIComponent(receiptNo)}&code=${encodeURIComponent(code)}`;
  }

  async invoiceIssued(invoiceId: string): Promise<number> {
    const context = await this.loadInvoice(invoiceId);
    if (!context) return 0;
    const { invoice, recipients } = context;
    for (const recipient of recipients) {
      await this.sms.queue({
        schoolId: invoice.schoolId,
        to: recipient.phone,
        template: 'invoice_issued',
        body: smsTemplates.invoiceIssued(recipient.language, this.invoiceData(invoice)),
        relatedType: 'Invoice',
        relatedId: invoice.id,
        dedupeKey: `inv-${invoice.id}-${recipient.guardianId}`,
      });
    }
    return recipients.length;
  }

  async invoiceReminder(invoiceId: string): Promise<number> {
    const context = await this.loadInvoice(invoiceId);
    if (!context) return 0;
    const { invoice, recipients } = context;
    const day = new Date().toISOString().slice(0, 10);
    for (const recipient of recipients) {
      await this.sms.queue({
        schoolId: invoice.schoolId,
        to: recipient.phone,
        template: 'invoice_reminder',
        body: smsTemplates.invoiceReminder(recipient.language, this.invoiceData(invoice)),
        relatedType: 'Invoice',
        relatedId: invoice.id,
        dedupeKey: `rem-${invoice.id}-${recipient.guardianId}-${day}`,
      });
    }
    await this.prisma.tenant(invoice.schoolId, (tx) => tx.invoice.update({ where: { id: invoice.id }, data: { lastReminderAt: new Date() } }));
    return recipients.length;
  }

  /** Receipt SMS to the payer (and the primary guardian if different); signed PDF by email when the payer gave one. */
  async receiptIssued(receiptId: string): Promise<void> {
    const receipt = await this.prisma.db.receipt.findUnique({
      where: { id: receiptId },
      include: {
        school: { select: { name: true } },
        payment: { select: { amount: true, method: true, payerName: true, payerPhone: true, payerEmail: true, succeededAt: true } },
        invoice: {
          select: {
            student: {
              select: {
                firstName: true,
                lastName: true,
                guardians: { where: { isPrimary: true }, include: { guardian: { select: { id: true, phone: true, language: true } } } },
              },
            },
          },
        },
      },
    });
    if (!receipt) return;
    const code = shortVerificationCode(receipt.payloadHash);
    const student = `${receipt.invoice.student.firstName} ${receipt.invoice.student.lastName}`;
    const data = {
      school: receipt.school.name,
      student,
      amount: receipt.payment.amount,
      receiptNo: receipt.receiptNo,
      code,
      link: this.verifyLink(receipt.receiptNo, code),
      methodLabel: payerMethodLabel(receipt.payment.method) || undefined,
    };
    const primary = receipt.invoice.student.guardians[0]?.guardian;
    const phones = new Map<string, Language>();
    phones.set(receipt.payment.payerPhone, primary && primary.phone === receipt.payment.payerPhone ? primary.language : 'am');
    if (primary && !phones.has(primary.phone)) phones.set(primary.phone, primary.language);
    for (const [phone, language] of phones) {
      await this.sms.queue({
        schoolId: receipt.schoolId,
        to: phone,
        template: 'receipt_issued',
        body: smsTemplates.receiptIssued(language, data),
        relatedType: 'Receipt',
        relatedId: receipt.id,
        dedupeKey: `rcpt-${receipt.id}-${phone.replace('+', '')}`,
      });
    }
    if (receipt.payment.payerEmail) {
      const message = emailTemplates.receiptIssued({ ...data, payerName: receipt.payment.payerName, paidAt: receipt.payment.succeededAt ?? receipt.issuedAt });
      await this.email.queue({
        schoolId: receipt.schoolId,
        to: receipt.payment.payerEmail,
        subject: message.subject,
        template: 'receipt_issued',
        html: message.html,
        text: message.text,
        attachments: receipt.pdfKey ? [{ filename: `${receipt.receiptNo}.pdf`, storageKey: receipt.pdfKey, contentType: 'application/pdf' }] : [],
        relatedType: 'Receipt',
        relatedId: receipt.id,
        dedupeKey: `rcpt-${receipt.id}`,
      });
    }
  }

  async parentOtp(phone: string, code: string, language: Language): Promise<void> {
    await this.sms.queue({ to: phone, template: 'parent_otp', body: smsTemplates.parentOtp(language, code) });
  }

  /**
   * Daily: remind guardians REMINDER_DAYS_BEFORE_DUE days before the due date, then weekly while
   * overdue (for up to OVERDUE_REMINDER_MAX_AGE_DAYS). Only active schools.
   */
  async sendScheduledReminders(): Promise<{ invoices: number; messages: number }> {
    const now = new Date();
    const today = addisDateOnly(now);
    const upcoming = addisDateOnly(now, REMINDER_DAYS_BEFORE_DUE);
    const repeatBefore = new Date(now.getTime() - OVERDUE_REMINDER_INTERVAL_DAYS * DAY_MS + 3600 * 1000);
    const oldest = addisDateOnly(now, -OVERDUE_REMINDER_MAX_AGE_DAYS);

    let invoices = 0;
    let messages = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.db.invoice.findMany({
        where: {
          status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
          school: { status: 'ACTIVE' },
          OR: [
            { dueDate: upcoming, lastReminderAt: null },
            { dueDate: { lt: today, gte: oldest }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: repeatBefore } }] },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: REMINDER_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const invoice of batch) {
        try {
          messages += await this.invoiceReminder(invoice.id);
          invoices += 1;
        } catch (error) {
          this.logger.warn(`Reminder for invoice ${invoice.id} failed: ${(error as Error).message}`);
        }
      }
      if (batch.length < REMINDER_BATCH) break;
      cursor = batch[batch.length - 1]?.id;
    }
    this.logger.log(`Fee reminders: ${messages} SMS for ${invoices} invoices`);
    return { invoices, messages };
  }

  private async loadInvoice(invoiceId: string) {
    const invoice = await this.prisma.db.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        school: { select: { name: true } },
        student: {
          select: {
            firstName: true,
            lastName: true,
            guardians: { include: { guardian: { select: { id: true, phone: true, language: true } } }, orderBy: { isPrimary: 'desc' } },
          },
        },
      },
    });
    if (!invoice) return null;
    const recipients: Recipient[] = invoice.student.guardians.map((link) => ({
      guardianId: link.guardian.id,
      phone: link.guardian.phone,
      language: link.guardian.language,
    }));
    return { invoice, recipients };
  }

  private invoiceData(invoice: NonNullable<Awaited<ReturnType<NotificationsService['loadInvoice']>>>['invoice']) {
    return {
      school: invoice.school.name,
      student: `${invoice.student.firstName} ${invoice.student.lastName}`,
      term: invoice.term,
      amount: invoice.totalAmount - invoice.paidAmount,
      dueDate: invoice.dueDate,
      link: this.payLink(invoice.payToken),
    };
  }
}
