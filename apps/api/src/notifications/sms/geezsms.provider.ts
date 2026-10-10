import { toInternationalDigits } from '@payment/shared';
import { SmsProviderError, type SmsProvider, type SmsSendRequest, type SmsSendResult } from './sms-provider.interface';

export interface GeezSmsConfig {
  token: string;
  shortcodeId?: string;
  baseUrl?: string;
}

interface GeezSmsResponse {
  error?: boolean | string;
  msg?: string;
  message?: string;
  message_status?: string;
  data?: { id?: string | number; message_id?: string | number };
}

/** https://geezsms.com — token in the body, phone as 2519XXXXXXXX. */
export class GeezSmsProvider implements SmsProvider {
  readonly name = 'geezsms';
  private readonly baseUrl: string;

  constructor(private readonly config: GeezSmsConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.geezsms.com/api/v1').replace(/\/$/, '');
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const body: Record<string, string> = {
      token: this.config.token,
      phone: toInternationalDigits(request.to),
      msg: request.message,
    };
    if (this.config.shortcodeId) body.shortcode_id = this.config.shortcodeId;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new SmsProviderError(`GeezSMS unreachable: ${(error as Error).message}`, true);
    }
    const payload = (await response.json().catch(() => ({}))) as GeezSmsResponse;
    const failed = !response.ok || payload.error === true || (typeof payload.error === 'string' && payload.error.length > 0) || (payload.message_status !== undefined && payload.message_status !== 'success');
    if (failed) {
      throw new SmsProviderError(`GeezSMS rejected the message: ${payload.msg ?? payload.message ?? response.status}`, response.status >= 500 || response.status === 429);
    }
    const id = payload.data?.message_id ?? payload.data?.id;
    return { providerMessageId: id === undefined ? undefined : String(id) };
  }
}
