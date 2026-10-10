'use client';

import { API_KEY_SCOPES, OUTBOUND_WEBHOOK_EVENTS } from '@payment/shared';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import {
  configureSettlementAction,
  createApiKeyAction,
  createStaffAction,
  createWebhookAction,
  type SecretState,
  updateSchoolAction,
} from './actions';

export function SchoolForm({
  school,
}: {
  school: { city: string | null; contactEmail: string; contactPhone: string; smsSenderName: string | null };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateSchoolAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="City" htmlFor="city">
        <Input id="city" name="city" defaultValue={school.city ?? ''} />
      </Field>
      <Field label="SMS sender name" htmlFor="smsSenderName" hint="Max 11 characters">
        <Input id="smsSenderName" name="smsSenderName" maxLength={11} defaultValue={school.smsSenderName ?? ''} />
      </Field>
      <Field label="Contact email" htmlFor="contactEmail">
        <Input id="contactEmail" name="contactEmail" type="email" defaultValue={school.contactEmail} />
      </Field>
      <Field label="Contact phone" htmlFor="contactPhone">
        <Input id="contactPhone" name="contactPhone" defaultValue={school.contactPhone} />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <FormMessage state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save school'}
        </Button>
      </div>
    </form>
  );
}

export function SettlementForm({ banks }: { banks: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(configureSettlementAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Bank" htmlFor="bankCode" className="sm:col-span-2">
        <Select id="bankCode" name="bankCode" required>
          <option value="">Select…</option>
          {banks.map((bank) => (
            <option key={bank.id} value={bank.id}>
              {bank.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Account number" htmlFor="accountNumber">
        <Input id="accountNumber" name="accountNumber" required />
      </Field>
      <Field label="Account name" htmlFor="accountName">
        <Input id="accountName" name="accountName" required />
      </Field>
      <Field label="Business name" htmlFor="businessName" className="sm:col-span-2">
        <Input id="businessName" name="businessName" required />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <FormMessage state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Registering…' : 'Register payout account'}
        </Button>
      </div>
    </form>
  );
}

export function StaffForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createStaffAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" htmlFor="staffName">
        <Input id="staffName" name="name" required />
      </Field>
      <Field label="Email" htmlFor="staffEmail">
        <Input id="staffEmail" name="email" type="email" required />
      </Field>
      <Field label="Role" htmlFor="role">
        <Select id="role" name="role" defaultValue="ACCOUNTANT">
          <option value="ACCOUNTANT">Accountant</option>
          <option value="SCHOOL_ADMIN">School admin</option>
        </Select>
      </Field>
      <Field label="Temporary password" htmlFor="password" hint="At least 10 characters, with a letter and a number">
        <Input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <FormMessage state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Add staff'}
        </Button>
      </div>
    </form>
  );
}

export function ApiKeyForm() {
  const [state, action, pending] = useActionState<SecretState, FormData>(createApiKeyAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="Name" htmlFor="keyName">
        <Input id="keyName" name="name" required placeholder="SIS integration" />
      </Field>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium text-gray-700">Scopes</legend>
        {API_KEY_SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="scope" value={scope} />
            {scope}
          </label>
        ))}
      </fieldset>
      <FormMessage state={state} />
      {state.secret ? <p className="break-all rounded-lg bg-amber-50 px-3 py-2 font-mono text-sm">{state.secret}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create API key'}
      </Button>
    </form>
  );
}

export function WebhookForm() {
  const [state, action, pending] = useActionState<SecretState, FormData>(createWebhookAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="HTTPS URL" htmlFor="url">
        <Input id="url" name="url" type="url" required placeholder="https://sis.example.com/webhooks/payments" />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-gray-700">Events</legend>
        {OUTBOUND_WEBHOOK_EVENTS.map((event) => (
          <label key={event} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="event" value={event} />
            {event}
          </label>
        ))}
      </fieldset>
      <FormMessage state={state} />
      {state.secret ? <p className="break-all rounded-lg bg-amber-50 px-3 py-2 font-mono text-sm">{state.secret}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Add webhook'}
      </Button>
    </form>
  );
}
