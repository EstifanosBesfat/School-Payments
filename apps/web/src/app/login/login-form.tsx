'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { loginAction, type LoginState } from './actions';

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={state.email} />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {state.needTotp ? (
        <Field label="Authenticator code" htmlFor="totpCode" hint="6 digits from the authenticator app already paired with this account.">
          <Input id="totpCode" name="totpCode" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" autoFocus required />
        </Field>
      ) : null}
      <FormMessage state={state} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
