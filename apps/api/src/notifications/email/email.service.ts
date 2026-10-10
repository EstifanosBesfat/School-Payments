import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_ENV, type AppEnv } from '../../config/config.module';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES, type SendEmailJob } from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import { STORAGE_DRIVER, type StorageDriver } from '../../storage/storage-driver.interface';

export interface QueueEmailInput {
  schoolId?: string | null;
  to: string;
  subject: string;
  template: string;
  html: string;
  text: string;
  attachments?: SendEmailJob['attachments'];
  relatedType?: string;
  relatedId?: string;
  dedupeKey?: string;
}

const MAX_ATTEMPTS = 5;

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport: Transporter;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    });
  }

  onModuleInit(): void {
    this.queues.register(QUEUES.notifications, JOBS.sendEmail, (job: Job<SendEmailJob>) => this.process(job));
  }

  async queue(input: QueueEmailInput): Promise<string> {
    const message = await this.prisma.db.emailMessage.create({
      data: {
        schoolId: input.schoolId ?? null,
        to: input.to,
        subject: input.subject,
        template: input.template,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
      },
    });
    await this.queues.add<SendEmailJob>(
      QUEUES.notifications,
      JOBS.sendEmail,
      { emailMessageId: message.id, html: input.html, text: input.text, attachments: input.attachments },
      { jobId: input.dedupeKey ? `email-${input.dedupeKey}` : `email-${message.id}`, attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 30_000 } },
    );
    return message.id;
  }

  private async process(job: Job<SendEmailJob>): Promise<void> {
    const message = await this.prisma.db.emailMessage.findUnique({ where: { id: job.data.emailMessageId } });
    if (!message || message.status === 'SENT') return;
    try {
      const attachments = await Promise.all(
        (job.data.attachments ?? []).map(async (attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: await this.storage.get(attachment.storageKey),
        })),
      );
      await this.transport.sendMail({
        from: this.env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: job.data.html,
        text: job.data.text,
        attachments,
      });
      await this.prisma.db.emailMessage.update({
        where: { id: message.id },
        data: { status: 'SENT', attempts: { increment: 1 }, sentAt: new Date(), error: null },
      });
    } catch (error) {
      const text = (error as Error).message;
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? MAX_ATTEMPTS);
      await this.prisma.db.emailMessage.update({
        where: { id: message.id },
        data: { status: finalAttempt ? 'FAILED' : 'QUEUED', attempts: { increment: 1 }, error: text.slice(0, 1000) },
      });
      this.logger.warn(`Email ${message.id} failed: ${text}`);
      throw error;
    }
  }
}
