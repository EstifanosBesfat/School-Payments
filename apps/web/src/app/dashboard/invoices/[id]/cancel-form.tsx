'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, FormMessage, Textarea } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { cancelInvoiceAction } from '../actions';

export function CancelForm({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(cancelInvoiceAction.bind(null, invoiceId), {});
  return (
    <Card>
      <CardHeader title="Cancel invoice" description="Only unpaid issued invoices can be cancelled." />
      <CardBody>
        <form action={action} className="space-y-3">
          <Field label="Reason" htmlFor="reason">
            <Textarea id="reason" name="reason" required minLength={3} />
          </Field>
          <FormMessage state={state} />
          <Button type="submit" variant="danger" disabled={pending}>
            {pending ? 'Cancelling…' : 'Cancel invoice'}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
