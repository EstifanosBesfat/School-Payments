'use client';

import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { newIdempotencyKey } from '@/lib/utils';
import { startPaymentAction, type StartPaymentState } from './actions';

const METHODS = [
  { value: 'telebirr', label: 'Telebirr · ቴሌብር', hint: 'Ethio Telecom numbers starting with 09 · የኢትዮ ቴሌኮም 09' },
  { value: 'cbe_birr', label: 'CBE Birr · ሲቢኢ ብር', hint: '09 or 07' },
] as const;

export function PayForm({
  token,
  amountLabel,
  gateway,
  startAction,
}: {
  token: string;
  amountLabel: string;
  gateway?: string;
  startAction?: (state: StartPaymentState, formData: FormData) => Promise<StartPaymentState>;
}) {
  const [state, action, pending] = useActionState<StartPaymentState, FormData>(startAction ?? startPaymentAction.bind(null, token), {});
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [payerEmail, setPayerEmail] = useState('');
  const [locked, setLocked] = useState(false);
  const lock = useRef(false);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending) {
      lock.current = false;
      setLocked(false);
    }
    wasPending.current = pending;
  }, [pending]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (lock.current || pending) {
      event.preventDefault();
      return;
    }
    lock.current = true;
    setLocked(true);
  }

  const busy = pending || locked;
  const showMethodSelection = gateway === 'arifpay';
  
  return (
    <form action={action} onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {showMethodSelection && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700">How do you want to pay? · የክፍያ መንገድ</legend>
          {METHODS.map((method) => (
            <label key={method.value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 px-3 py-2.5">
              <input className="mt-1" type="radio" name="method" value={method.value} defaultChecked={method.value === 'telebirr'} required />
              <span>
                <span className="block text-sm font-semibold">{method.label}</span>
                <span className="block text-xs text-gray-500">{method.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <Field label="Your full name · ሙሉ ስም" htmlFor="payerName">
        <Input id="payerName" name="payerName" autoComplete="name" required minLength={2} value={payerName} onChange={(event) => setPayerName(event.target.value)} />
      </Field>
      <Field label="Phone number · ስልክ ቁጥር" htmlFor="payerPhone" hint="Your receipt is sent here by SMS">
        <Input id="payerPhone" name="payerPhone" type="tel" inputMode="tel" autoComplete="tel" placeholder="09XXXXXXXX" required value={payerPhone} onChange={(event) => setPayerPhone(event.target.value)} />
      </Field>
      <Field label="Email (optional) · ኢሜይል" htmlFor="payerEmail" hint="We email the signed PDF receipt">
        <Input id="payerEmail" name="payerEmail" type="email" autoComplete="email" value={payerEmail} onChange={(event) => setPayerEmail(event.target.value)} />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? 'Starting your payment…' : `Pay ${amountLabel} · ክፈል`}
      </Button>
    </form>
  );
}
