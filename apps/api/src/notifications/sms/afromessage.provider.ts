import { SmsProviderError, type SmsProvider, type SmsSendRequest, type SmsSendResult } from './sms-provider.interface';

export interface AfroMessageConfig {
  token: string;
  identifierId?: string;
  senderName?: string;
  baseUrl?: string;
}

interface AfroMessageResponse {
  acknowledge?: string;
  response?: { message_id?: string; errors?: string[] | string; message?: string } | string;
}

/** https://www.afromessage.com/developers — single send endpoint, Bearer token auth. */
export class AfroMessageProvider implements SmsProvider {
  readonly name = 'afromessage';
  private readonly baseUrl: string;

  constructor(private readonly config: AfroMessageConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.afromessage.com/api').replace(/\/$/, '');
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const body: Record<string, string> = { to: request.to, message: request.message };
    if (this.config.identifierId) body.from = this.config.identifierId;
    const sender = this.config.senderName ?? request.sender;
    if (sender) body.sender = sender;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new SmsProviderError(`AfroMessage unreachable: ${(error as Error).message}`, true);
    }
    const payload = (await response.json().catch(() => ({}))) as AfroMessageResponse;
    if (!response.ok || payload.acknowledge !== 'success') {
      const detail = typeof payload.response === 'string' ? payload.response : JSON.stringify(payload.response?.errors ?? payload.response ?? response.status);
      throw new SmsProviderError(`AfroMessage rejected the message: ${detail}`, response.status >= 500 || response.status === 429);
    }
    const messageId = typeof payload.response === 'object' ? payload.response.message_id : undefined;
    return { providerMessageId: messageId };
  }
}
