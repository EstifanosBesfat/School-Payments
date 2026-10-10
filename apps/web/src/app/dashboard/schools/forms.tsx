'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { createSchoolAction, setSchoolStatusAction } from './actions';

export function CreateSchoolForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createSchoolAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="School name" htmlFor="name">
        <Input id="name" name="name" required />
      </Field>
      <Field label="Code" htmlFor="code" hint="2–10 letters or digits">
        <Input id="code" name="code" required minLength={2} maxLength={10} className="uppercase" />
      </Field>
      <Field label="Contact email" htmlFor="contactEmail">
        <Input id="contactEmail" name="contactEmail" type="email" required />
      </Field>
      <Field label="Contact phone" htmlFor="contactPhone">
        <Input id="contactPhone" name="contactPhone" required />
      </Field>
      <Field label="City" htmlFor="city">
        <Input id="city" name="city" />
      </Field>
      <Field label="Admin name" htmlFor="adminName">
        <Input id="adminName" name="adminName" required />
      </Field>
      <Field label="Admin email" htmlFor="adminEmail">
        <Input id="adminEmail" name="adminEmail" type="email" required />
      </Field>
      <Field label="Admin password" htmlFor="adminPassword">
        <Input id="adminPassword" name="adminPassword" type="password" required minLength={10} autoComplete="new-password" />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <FormMessage state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create school'}
        </Button>
      </div>
    </form>
  );
}

export function StatusForm({ schoolId, status }: { schoolId: string; status: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setSchoolStatusAction.bind(null, schoolId), {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Select name="status" defaultValue={status} className="w-40">
        <option value="ONBOARDING">Onboarding</option>
        <option value="ACTIVE">Active</option>
        <option value="SUSPENDED">Suspended</option>
      </Select>
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        Update
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
