export interface SmsSendRequest {
  /** E.164, e.g. +251912345678 */
  to: string;
  message: string;
  /** Registered sender name for the school, when the provider supports per-message senders. */
  sender?: string;
}

export interface SmsSendResult {
  providerMessageId?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

export class SmsProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SmsProviderError';
  }
}
