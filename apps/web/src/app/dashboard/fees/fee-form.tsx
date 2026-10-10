'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Textarea } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { createFeeItemAction } from './actions';

export function CreateFeeForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createFeeItemAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" htmlFor="name">
        <Input id="name" name="name" required placeholder="Term 1 tuition" />
      </Field>
      <Field label="Amount (ETB)" htmlFor="amountEtb">
        <Input id="amountEtb" name="amountEtb" inputMode="decimal" required placeholder="1500.00" />
      </Field>
      <Field label="Description" htmlFor="description" className="sm:col-span-2">
        <Textarea id="description" name="description" rows={2} />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <FormMessage state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add fee item'}
        </Button>
      </div>
    </form>
  );
}
