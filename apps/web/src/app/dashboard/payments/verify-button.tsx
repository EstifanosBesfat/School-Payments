'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form';
import type { FormState } from '@/lib/utils';
import { verifyPaymentAction } from './actions';

export function VerifyButton({ paymentId }: { paymentId: string }) {
  const [state, setState] = useState<FormState>({});
  const [pending, start] = useTransition();
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => start(async () => setState(await verifyPaymentAction(paymentId)))}
      >
        {pending ? 'Checking…' : 'Verify now'}
      </Button>
      <FormMessage state={state} />
    </div>
  );
}
