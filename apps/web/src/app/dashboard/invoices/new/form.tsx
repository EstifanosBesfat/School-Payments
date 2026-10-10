'use client';

import { formatEtb } from '@payment/shared';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { newIdempotencyKey, type FormState } from '@/lib/utils';
import { createInvoiceAction } from '../actions';

export function InvoiceCreateForm({
  students,
  feeItems,
}: {
  students: { id: string; code: string; firstName: string; lastName: string; grade: string; section: string | null }[];
  feeItems: { id: string; name: string; amount: number }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createInvoiceAction, {});
  const [idempotencyKey] = useState(newIdempotencyKey);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field label="Student" htmlFor="studentId">
        <Select id="studentId" name="studentId" required>
          <option value="">Select…</option>
          {students.map((student) => (
            <option key={student.id} value={student.id}>
              {student.code} · {student.firstName} {student.lastName} ({student.grade}
              {student.section ? ` ${student.section}` : ''})
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Term" htmlFor="term">
          <Input id="term" name="term" placeholder="2026 T1" />
        </Field>
        <Field label="Due date" htmlFor="dueDate">
          <Input id="dueDate" name="dueDate" type="date" required />
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Fee items</legend>
        {feeItems.length === 0 ? <p className="text-sm text-gray-500">Create a fee item first, or add a custom line below.</p> : null}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Extra line (optional)" htmlFor="extraDescription">
          <Input id="extraDescription" name="extraDescription" placeholder="Uniform" />
        </Field>
        <Field label="Extra amount (ETB)" htmlFor="extraAmountEtb">
          <Input id="extraAmountEtb" name="extraAmountEtb" inputMode="decimal" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="notify" defaultChecked />
        Send SMS to the primary guardian
      </label>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Issuing…' : 'Issue invoice'}
      </Button>
    </form>
  );
}
