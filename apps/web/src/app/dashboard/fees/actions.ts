'use server';

import { revalidatePath } from 'next/cache';
import { errorMessage, staffApi } from '@/lib/api';
import { parseEtbInput, type FormState } from '@/lib/utils';

export async function createFeeItemAction(_previous: FormState, formData: FormData): Promise<FormState> {
  let amount: number;
  try {
    amount = parseEtbInput(String(formData.get('amountEtb') ?? ''));
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid amount' };
  }
  try {
    await staffApi('/fee-items', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? '').trim(),
        description: String(formData.get('description') ?? '').trim() || undefined,
        amount,
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/fees');
  return { success: 'Fee item saved.' };
}

export async function setFeeItemActiveAction(id: string, isActive: boolean): Promise<void> {
  await staffApi(`/fee-items/${encodeURIComponent(id)}`, { method: 'PATCH', body: { isActive } });
  revalidatePath('/dashboard/fees');
}
