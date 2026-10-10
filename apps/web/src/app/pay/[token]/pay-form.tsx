'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { newIdempotencyKey } from '@/lib/utils';
import { startPaymentAction, type StartPaymentState } from './actions';

export function PayForm({ token, amountLabel }: { token: string; amountLabel: string }) {
  const [state, action, pending] = useActionState<StartPaymentState, FormData>(startPaymentAction.bind(null, token), {});
  const [idempotencyKey] = useState(newIdempotencyKey);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field label="Your full name · ሙሉ ስም" htmlFor="payerName">
        <Input id="payerName" name="payerName" autoComplete="name" required minLength={2} />
      </Field>
      <Field label="Phone number · ስልክ ቁጥር" htmlFor="payerPhone" hint="Your receipt is sent here by SMS">
        <Input id="payerPhone" name="payerPhone" type="tel" inputMode="tel" autoComplete="tel" placeholder="09XXXXXXXX" required />
      </Field>
      <Field label="Email (optional) · ኢሜይል" htmlFor="payerEmail" hint="We email the signed PDF receipt">
        <Input id="payerEmail" name="payerEmail" type="email" autoComplete="email" />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? 'Opening secure checkout…' : `Pay ${amountLabel} · ክፈል`}
      </Button>
      <p className="text-center text-xs text-gray-500">telebirr · CBE Birr · M-Pesa · Amole · Visa/Mastercard. You complete payment on the gateway’s secure page.</p>
    </form>
  );
}
