'use server';

import { redirect } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';

export interface StartPaymentState {
  error?: string;
}

export async function startPaymentAction(token: string, _previous: StartPaymentState, formData: FormData): Promise<StartPaymentState> {
  const email = String(formData.get('payerEmail') ?? '').trim();
  let checkoutUrl: string;
  try {
    const result = await api<{ checkoutUrl: string; txRef: string }>(`/pay/${encodeURIComponent(token)}/start`, {
      method: 'POST',
      auth: 'none',
      idempotencyKey: String(formData.get('idempotencyKey') ?? '') || undefined,
      body: {
        payerName: String(formData.get('payerName') ?? '').trim(),
        payerPhone: String(formData.get('payerPhone') ?? '').trim(),
        ...(email ? { payerEmail: email } : {}),
      },
    });
    checkoutUrl = result.checkoutUrl;
  } catch (error) {
    return { error: errorMessage(error) };
  }
  redirect(checkoutUrl);
}
