'use server';

import { revalidatePath } from 'next/cache';
import { errorMessage, staffApi } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export async function verifyPaymentAction(id: string): Promise<FormState> {
  try {
    const result = await staffApi<{ outcome: string }>(`/payments/${encodeURIComponent(id)}/verify`, { method: 'POST' });
    revalidatePath('/dashboard/payments');
    return { success: `Gateway reported: ${result.outcome}` };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
