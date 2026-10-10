'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input, Select, Textarea } from '@/components/ui/form';
import { createStudentAction, importStudentsAction } from './actions';
import type { FormState } from '@/lib/utils';

export function CreateStudentForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createStudentAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label="Student code" htmlFor="code">
        <Input id="code" name="code" required />
      </Field>
      <Field label="Grade" htmlFor="grade">
        <Input id="grade" name="grade" required placeholder="5" />
      </Field>
      <Field label="First name" htmlFor="firstName">
        <Input id="firstName" name="firstName" required />
      </Field>
      <Field label="Last name" htmlFor="lastName">
        <Input id="lastName" name="lastName" required />
      </Field>
      <Field label="Section" htmlFor="section">
        <Input id="section" name="section" placeholder="A" />
      </Field>
      <Field label="Guardian language" htmlFor="language">
        <Select id="language" name="language" defaultValue="am">
          <option value="am">Amharic</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <Field label="Guardian name" htmlFor="guardianName">
        <Input id="guardianName" name="guardianName" required />
      </Field>
      <Field label="Guardian phone" htmlFor="guardianPhone">
        <Input id="guardianPhone" name="guardianPhone" type="tel" required placeholder="09XXXXXXXX" />
      </Field>
      <div className="sm:col-span-2 space-y-3">
        <FormMessage state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add student'}
        </Button>
      </div>
    </form>
  );
}

export function ImportStudentsForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(importStudentsAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field
        label="CSV file"
        htmlFor="file"
        hint="Columns: code, firstName, lastName, grade, section, guardianName, guardianPhone, language"
      >
        <Input id="file" name="file" type="file" accept=".csv,text/csv" />
      </Field>
      <Field label="Or paste CSV" htmlFor="csv">
        <Textarea id="csv" name="csv" rows={4} placeholder="STU-001,Abebe,Kebede,5,A,Almaz Kebede,0912345678,am" />
      </Field>
      <FormMessage state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Importing…' : 'Import'}
      </Button>
    </form>
  );
}
