'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { FormMessage, Input } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { resolveIssueAction } from './actions';

export function ResolveForm({ issueId }: { issueId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(resolveIssueAction.bind(null, issueId), {});
  return (
    <form action={action} className="space-y-2">
      <Input name="note" required minLength={3} placeholder="Resolution note" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? 'Saving…' : 'Resolve'}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
