'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { newIdempotencyKey } from '@/lib/utils';
import type { FormState } from '@/lib/utils';
import { attachPaymentAction } from '../actions';

export function AttachPaymentForm({ invoiceId, balanceLabel }: { invoiceId: string; balanceLabel: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(attachPaymentAction.bind(null, invoiceId), {});
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  return (
    <Card>
      <CardHeader
        title="Attach a gateway transaction"
        description={`For a payment completed on the gateway's own page after a failed attempt. Paste the merchant reference (tx_ref) from the gateway dashboard. It is verified with the gateway and must equal the ${balanceLabel} balance exactly before anything is recorded.`}
      />
      <CardBody>
        <form
          action={(formData) => {
            action(formData);
            setIdempotencyKey(newIdempotencyKey());
          }}
          className="space-y-3"
        >
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <Field label="Merchant reference (tx_ref)" htmlFor="txRef" hint="Not the gateway's own reference such as APxxxxxxxxxx; use the tx_ref column.">
            <Input id="txRef" name="txRef" required minLength={3} maxLength={100} className="font-mono" autoComplete="off" spellCheck={false} />
          </Field>
          <FormMessage state={state} />
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? 'Verifying with gateway…' : 'Verify and attach'}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
