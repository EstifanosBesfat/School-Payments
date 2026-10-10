'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { requestOtpAction, verifyOtpAction, type ParentOtpState } from './actions';

export function ParentOtpForm() {
  const [requestState, request, requesting] = useActionState<ParentOtpState, FormData>(requestOtpAction, {});
  const [verifyState, verify, verifying] = useActionState<ParentOtpState, FormData>(verifyOtpAction, {});
  const phone = verifyState.phone ?? requestState.phone ?? '';

  if (!requestState.sent) {
    return (
      <form action={request} className="space-y-4">
        <Field label="Phone number · ስልክ ቁጥር" htmlFor="phone" hint="The number the school has for you">
          <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="09XXXXXXXX" required defaultValue={phone} />
        </Field>
        <FormMessage state={requestState} />
        <Button type="submit" className="w-full" disabled={requesting}>
          {requesting ? 'Sending…' : 'Send code · ኮድ ላክ'}
        </Button>
      </form>
    );
  }

  return (
    <form action={verify} className="space-y-4">
      <input type="hidden" name="phone" value={phone} />
      <p className="text-sm text-gray-600">{requestState.success}</p>
      <Field label="6-digit code · ኮድ" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
      </Field>
      <FormMessage state={verifyState} />
      <Button type="submit" className="w-full" disabled={verifying}>
        {verifying ? 'Checking…' : 'Open my children · ግባ'}
      </Button>
    </form>
  );
}
