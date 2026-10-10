'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { errorMessage, staffApi } from '@/lib/api';
import { parseEtbInput, type FormState } from '@/lib/utils';

export async function createInvoiceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const feeItemIds = formData.getAll('feeItemId').map(String).filter(Boolean);
  const extraDescription = String(formData.get('extraDescription') ?? '').trim();
  const extraAmount = String(formData.get('extraAmountEtb') ?? '').trim();
  const lines: { feeItemId?: string; description: string; amount: number }[] = [];

  const catalogue = await staffApi<{ id: string; name: string; amount: number }[]>('/fee-items');
  for (const id of feeItemIds) {
    const item = catalogue.find((fee) => fee.id === id);
    if (!item) return { error: 'Unknown fee item' };
    lines.push({ feeItemId: item.id, description: item.name, amount: item.amount });
  }
  if (extraDescription) {
    try {
      lines.push({ description: extraDescription, amount: parseEtbInput(extraAmount) });
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid extra amount' };
    }
  }
  if (lines.length === 0) return { error: 'Add at least one fee line' };

  let invoice: { id: string };
  try {
    invoice = await staffApi<{ id: string }>('/invoices', {
      method: 'POST',
      idempotencyKey: String(formData.get('idempotencyKey') ?? '') || undefined,
      body: {
        studentId: String(formData.get('studentId') ?? ''),
        term: String(formData.get('term') ?? '').trim() || undefined,
        dueDate: String(formData.get('dueDate') ?? ''),
        notify: formData.get('notify') === 'on',
        lines,
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/invoices');
  redirect(`/dashboard/invoices/${invoice.id}`);
}

export async function createBulkInvoiceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    const result = await staffApi<{ created: number; skipped: number }>('/invoices/bulk', {
      method: 'POST',
      idempotencyKey: String(formData.get('idempotencyKey') ?? '') || undefined,
      body: {
        grade: String(formData.get('grade') ?? '').trim(),
        section: String(formData.get('section') ?? '').trim() || undefined,
        term: String(formData.get('term') ?? '').trim() || undefined,
        dueDate: String(formData.get('dueDate') ?? ''),
        feeItemIds: formData.getAll('feeItemId').map(String).filter(Boolean),
        notify: formData.get('notify') === 'on',
      },
    });
    revalidatePath('/dashboard/invoices');
    return { success: `Issued ${result.created} invoices (${result.skipped} students already billed for this term).` };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function cancelInvoiceAction(id: string, _previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi(`/invoices/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: { reason: String(formData.get('reason') ?? '').trim() },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath(`/dashboard/invoices/${id}`);
  revalidatePath('/dashboard/invoices');
  return { success: 'Invoice cancelled.' };
}

export async function remindInvoiceAction(id: string): Promise<void> {
  await staffApi(`/invoices/${encodeURIComponent(id)}/remind`, { method: 'POST' });
  revalidatePath(`/dashboard/invoices/${id}`);
}
