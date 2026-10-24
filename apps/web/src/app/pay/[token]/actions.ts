'use server';

import { startPaymentSchema, type StartPaymentResult } from '@payment/shared';
import { redirect } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';

export interface StartPaymentState {
  error?: string;
}

export async function startPaymentAction(token: string, _previous: StartPaymentState, formData: FormData): Promise<StartPaymentState> {
  const email = String(formData.get('payerEmail') ?? '').trim();
  const parsed = startPaymentSchema.safeParse({
    payerName: String(formData.get('payerName') ?? '').trim(),
    payerPhone: String(formData.get('payerPhone') ?? '').trim(),
    method: String(formData.get('method') ?? '').trim(),
    ...(email ? { payerEmail: email } : {}),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  let result: StartPaymentResult;
  try {
    result = await api<StartPaymentResult>(`/pay/${encodeURIComponent(token)}/start`, {
      method: 'POST',
      auth: 'none',
      idempotencyKey: String(formData.get('idempotencyKey') ?? '') || undefined,
      body: parsed.data,
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  if (result.kind === 'redirect') redirect(result.checkoutUrl);
  redirect(`/pay/${encodeURIComponent(token)}/prompt?tx=${encodeURIComponent(result.txRef)}`);
}
