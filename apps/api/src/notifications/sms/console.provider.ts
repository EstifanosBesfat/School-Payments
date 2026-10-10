import { Logger } from '@nestjs/common';
import { maskPhone } from '@payment/shared';
import { randomUUID } from 'node:crypto';
import type { SmsProvider, SmsSendRequest, SmsSendResult } from './sms-provider.interface';

/** Development provider: writes the SMS to the API log instead of sending it. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  private readonly logger = new Logger('SMS');

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const id = randomUUID();
    this.logger.log(`[${id}] to ${maskPhone(request.to)}${request.sender ? ` from ${request.sender}` : ''}:\n${request.message}`);
    return { providerMessageId: id };
  }
}
