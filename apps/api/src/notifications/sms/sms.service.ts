import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { maskPhone } from '@payment/shared';
import type { Job } from 'bullmq';
import { APP_ENV, type AppEnv } from '../../config/config.module';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES, type SendSmsJob } from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import { AfroMessageProvider } from './afromessage.provider';
import { ConsoleSmsProvider } from './console.provider';
import { GeezSmsProvider } from './geezsms.provider';
import { SmsProviderError, type SmsProvider } from './sms-provider.interface';

export interface QueueSmsInput {
  schoolId?: string | null;
  to: string;
  body: string;
  template: string;
  sender?: string | null;
  relatedType?: string;
  relatedId?: string;
  /** Deduplicates repeat sends of the same logical message (e.g. one receipt SMS per receipt). */
  dedupeKey?: string;
}

const MAX_ATTEMPTS = 5;

@Injectable()
export class SmsService implements OnModuleInit {
  private readonly logger = new Logger(SmsService.name);
  private readonly providers: SmsProvider[];

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {
    const names = [env.SMS_PROVIDER, env.SMS_FALLBACK_PROVIDER].filter((name, index, all): name is NonNullable<typeof name> => Boolean(name) && all.indexOf(name) === index);
    this.providers = names.map((name) => this.build(name));
  }

  onModuleInit(): void {
    this.queues.register(QUEUES.notifications, JOBS.sendSms, (job: Job<SendSmsJob>) => this.process(job));
  }

  private build(name: 'console' | 'afromessage' | 'geezsms'): SmsProvider {
    switch (name) {
      case 'afromessage':
        return new AfroMessageProvider({
          token: this.env.AFROMESSAGE_TOKEN ?? '',
          identifierId: this.env.AFROMESSAGE_IDENTIFIER_ID,
          senderName: this.env.AFROMESSAGE_SENDER_NAME,
        });
      case 'geezsms':
        return new GeezSmsProvider({ token: this.env.GEEZSMS_TOKEN ?? '', shortcodeId: this.env.GEEZSMS_SHORTCODE_ID });
      case 'console':
        return new ConsoleSmsProvider();
    }
  }

  async queue(input: QueueSmsInput): Promise<string> {
    const message = await this.prisma.db.smsMessage.create({
      data: {
        schoolId: input.schoolId ?? null,
        to: input.to,
        body: input.body,
        template: input.template,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
      },
    });
    await this.queues.add<SendSmsJob>(QUEUES.notifications, JOBS.sendSms, { smsMessageId: message.id }, {
      jobId: input.dedupeKey ? `sms-${input.dedupeKey}` : `sms-${message.id}`,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 15_000 },
    });
    return message.id;
  }

  private async process(job: Job<SendSmsJob>): Promise<void> {
    const message = await this.prisma.db.smsMessage.findUnique({ where: { id: job.data.smsMessageId } });
    if (!message || message.status === 'SENT') return;
    const sender = message.schoolId
      ? (await this.prisma.db.school.findUnique({ where: { id: message.schoolId }, select: { smsSenderName: true } }))?.smsSenderName ?? undefined
      : undefined;

    const errors: string[] = [];
    let retryable = false;
    for (const provider of this.providers) {
      try {
        const result = await provider.send({ to: message.to, message: message.body, sender });
        await this.prisma.db.smsMessage.update({
          where: { id: message.id },
          data: { status: 'SENT', provider: provider.name, providerMessageId: result.providerMessageId, attempts: { increment: 1 }, sentAt: new Date(), error: null },
        });
        return;
      } catch (error) {
        const text = (error as Error).message;
        errors.push(`${provider.name}: ${text}`);
        if (!(error instanceof SmsProviderError) || error.retryable) retryable = true;
        this.logger.warn(`SMS ${message.id} to ${maskPhone(message.to)} failed via ${provider.name}: ${text}`);
      }
    }

    const finalAttempt = !retryable || job.attemptsMade + 1 >= (job.opts.attempts ?? MAX_ATTEMPTS);
    await this.prisma.db.smsMessage.update({
      where: { id: message.id },
      data: { status: finalAttempt ? 'FAILED' : 'QUEUED', attempts: { increment: 1 }, error: errors.join(' | ').slice(0, 1000) },
    });
    if (!finalAttempt) throw new Error(errors.join(' | '));
  }
}
