'use client';

import { useActionState, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormMessage, Input } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { FormState } from '@/lib/utils';
import { resolveIssueAction } from './actions';

const QUICK_RESOLUTIONS: Record<string, string[]> = {
  status_mismatch: [
    'Manually attached payment via Chapa reference',
    'Verified with Chapa support - webhook delivery failed',
    'Payment succeeded on retry - sweep worker caught it',
  ],
  gateway_tx_unknown: [
    'Parent completed retry inside Chapa checkout',
    'Attached payment using gateway reference',
    'Verified amount matches invoice',
  ],
  amount_mismatch: [
    'Investigated with Chapa support - confirmed amount',
    'Partial refund issued to parent',
    'Test transaction - ignored',
  ],
  missing_at_gateway: [
    'Confirmed with Chapa - not in their system',
    'Test transaction - marked for reversal',
    'Duplicate entry - removed',
  ],
};

export function ResolveForm({ issueId, txRef, kind }: { issueId: string; txRef: string | null; kind: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    resolveIssueAction.bind(null, issueId),
    {},
  );
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  const quickResolutions = QUICK_RESOLUTIONS[kind] || [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Resolve
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Resolve Issue</DialogTitle>
          <DialogDescription>
            Mark this reconciliation issue as resolved with a note explaining what was done.
            {txRef ? (
              <span className="mt-2 block font-mono text-xs text-gray-600">Reference: {txRef}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-4">
          <div>
            <label htmlFor="note" className="block text-sm font-medium text-gray-700">
              Resolution Note <span className="text-red-500">*</span>
            </label>
            <Input
              id="note"
              name="note"
              required
              minLength={10}
              maxLength={500}
              placeholder="Describe what you did to resolve this issue..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-gray-500">
              Be specific. This note will be stored in the audit log.
            </p>
          </div>

          {quickResolutions.length > 0 ? (
            <div>
              <p className="text-sm font-medium text-gray-700">Quick Templates:</p>
              <div className="mt-2 space-y-2">
                {quickResolutions.map((template, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setNote(template)}
                    className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    {template}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <FormMessage state={state} />

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || note.length < 10}>
              {pending ? 'Resolving…' : 'Mark as Resolved'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
