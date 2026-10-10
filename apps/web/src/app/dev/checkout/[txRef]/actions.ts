'use server';

import { redirect } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export async function completeMockPayment(txRef: string, _previous: FormState, formData: FormData): Promise<FormState> {
  let returnUrl: string;
  try {
    const result = await api<{ returnUrl: string }>(`/dev/mock-gateway/${encodeURIComponent(txRef)}/complete`, {
      method: 'POST',
      auth: 'none',
      body: { outcome: String(formData.get('outcome') ?? 'success'), method: String(formData.get('method') ?? 'telebirr') },
    });
    returnUrl = result.returnUrl;
  } catch (error) {
    return { error: errorMessage(error) };
  }
  redirect(returnUrl);
}
