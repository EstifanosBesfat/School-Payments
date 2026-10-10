'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Select } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { completeMockPayment } from './actions';

export function CheckoutForm({ txRef }: { txRef: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(completeMockPayment.bind(null, txRef), {});
  return (
    <form action={action} className="space-y-4">
      <Field label="Method" htmlFor="method">
        <Select id="method" name="method" defaultValue="telebirr">
          <option value="telebirr">telebirr</option>
          <option value="cbebirr">CBE Birr</option>
          <option value="mpesa">M-Pesa</option>
          <option value="card">Card</option>
          <option value="bank">Bank transfer</option>
        </Select>
      </Field>
      <FormMessage state={state} />
      <div className="flex gap-2">
        <Button type="submit" name="outcome" value="success" className="flex-1" disabled={pending}>
          {pending ? 'Working…' : 'Pay successfully'}
        </Button>
        <Button type="submit" name="outcome" value="failed" variant="secondary" className="flex-1" disabled={pending}>
          Fail payment
        </Button>
      </div>
    </form>
  );
}
