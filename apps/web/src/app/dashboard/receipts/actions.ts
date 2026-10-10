'use server';

import { revalidatePath } from 'next/cache';
import { errorMessage, staffApi } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export async function verifyChainAction(): Promise<FormState> {
  try {
    const result = await staffApi<{ receipts: number; valid: boolean; problems: { receiptNo: string; problem: string }[] }>(
      '/receipts/chain/verify',
      { method: 'POST' },
    );
    revalidatePath('/dashboard/receipts');
    const noun = result.receipts === 1 ? 'receipt' : 'receipts';
    if (result.valid) return { success: `Chain is valid (${result.receipts} ${noun}).` };
    return { error: `Chain broken: ${result.problems.map((problem) => `${problem.receiptNo} ${problem.problem}`).join('; ')}` };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
