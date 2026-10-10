'use client';

import { formatEtb } from '@payment/shared';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { newIdempotencyKey, type FormState } from '@/lib/utils';
import { createBulkInvoiceAction } from '../actions';

export function BulkInvoiceForm({
  grades,
  feeItems,
}: {
  grades: { grade: string; section: string | null; students: number }[];
  feeItems: { id: string; name: string; amount: number }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createBulkInvoiceAction, {});
  const [idempotencyKey] = useState(newIdempotencyKey);
  const uniqueGrades = [...new Set(grades.map((row) => row.grade))];
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Grade" htmlFor="grade">
          <Select id="grade" name="grade" required>
            <option value="">Select…</option>
            {uniqueGrades.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Section (optional)" htmlFor="section">
          <Input id="section" name="section" placeholder="A" />
        </Field>
        <Field label="Term" htmlFor="term">
          <Input id="term" name="term" placeholder="2026 T1" />
        </Field>
        <Field label="Due date" htmlFor="dueDate">
          <Input id="dueDate" name="dueDate" type="date" required />
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Fee items</legend>
        {feeItems.map((item) => (
          <label key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <input type="checkbox" name="feeItemId" value={item.id} />
              {item.name}
            </span>
            <span className="tabular-nums text-gray-600">{formatEtb(item.amount)}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="notify" defaultChecked />
        Send SMS to each primary guardian
      </label>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Issuing…' : 'Issue invoices'}
      </Button>
    </form>
  );
}
