'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { runReconciliationAction } from './actions';

export function RunButton() {
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <Button type="button" disabled={pending} onClick={() => start(async () => setState(await runReconciliationAction()))}>
        {pending ? 'Running…' : 'Run now'}
      </Button>
      <FormMessage state={state} />
    </div>
  );
}
