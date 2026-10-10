'use server';

import { revalidatePath } from 'next/cache';
import { errorMessage, staffApi } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export async function runReconciliationAction(): Promise<FormState> {
  try {
    const result = await staffApi<{ checked: number; issues: number; settledLate: number; receiptsRequeued: number }>('/reconciliation/run', {
      method: 'POST',
    });
    revalidatePath('/dashboard/reconciliation');
    return { success: `Checked ${result.checked} payments. ${result.issues} new issues, ${result.settledLate} settled late.` };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function resolveIssueAction(id: string, _previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi(`/reconciliation/issues/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: { note: String(formData.get('note') ?? '').trim() },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/reconciliation');
  return { success: 'Issue marked resolved.' };
}
