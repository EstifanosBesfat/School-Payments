'use client';

import { useActionState, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { beginSetupAction, enableTotpAction, type TotpSetupState } from './actions';

export function SetupForm() {
  const [setup, setSetup] = useState<TotpSetupState | null>(null);
  const [starting, startTransition] = useTransition();
  const [state, enable, enabling] = useActionState<TotpSetupState, FormData>(enableTotpAction, {});

  if (!setup?.qrCodeDataUrl) {
    return (
      <div className="space-y-4">
        <FormMessage state={setup} />
        <Button className="w-full" disabled={starting} onClick={() => startTransition(async () => setSetup(await beginSetupAction()))}>
          {starting ? 'Preparing…' : 'Show QR code'}
        </Button>
      </div>
    );
  }

  return (
    <form action={enable} className="space-y-5">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-600">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan this QR code, or type the key below.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={setup.qrCodeDataUrl} alt="Two-factor setup QR code" width={200} height={200} className="mx-auto rounded-lg border border-gray-200" />
      <p className="break-all rounded-lg bg-gray-100 px-3 py-2 text-center font-mono text-sm tracking-wider">{setup.secret}</p>
      <Field label="Code from the app" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" className="w-full" disabled={enabling}>
        {enabling ? 'Checking…' : 'Turn on two-factor authentication'}
      </Button>
    </form>
  );
}
