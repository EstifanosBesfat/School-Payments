'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { verifyChainAction } from './actions';

export function ChainButton() {
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => start(async () => setState(await verifyChainAction()))}>
        {pending ? 'Checking chain…' : 'Verify hash chain'}
      </Button>
      <FormMessage state={state} />
    </div>
  );
}
