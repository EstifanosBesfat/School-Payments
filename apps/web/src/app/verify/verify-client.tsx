'use client';

import { formatEtb, type ReceiptPayload, type ReceiptPublicKeys, decodeReceiptQr, verifyReceiptSignature } from '@payment/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormMessage, Input } from '@/components/ui/form';
import { formatDateTime } from '@/lib/utils';

type View =
  | { kind: 'idle' }
  | { kind: 'valid'; payload: ReceiptPayload; code: string; source: 'qr' | 'lookup' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; message: string };

function keysFromEnv(): ReceiptPublicKeys {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_RECEIPT_PUBLIC_KEYS ?? '{}') as ReceiptPublicKeys;
  } catch {
    return {};
  }
}

function reasonText(reason: string): string {
  if (reason === 'unknown_key') return 'This receipt was signed with a key this site does not know.';
  if (reason === 'bad_signature') return 'The signature does not match. This receipt may have been altered.';
  if (reason === 'malformed') return 'This QR code is not a valid receipt.';
  return reason;
}

function ReceiptCard({ payload, code, source }: { payload: ReceiptPayload; code: string; source: 'qr' | 'lookup' }) {
  return (
    <div className="space-y-3 rounded-lg border border-brand-500 bg-brand-50 p-4">
      <p className="text-sm font-semibold text-brand-800">{source === 'qr' ? 'Signature valid (checked in your browser)' : 'Matches a receipt on this platform'}</p>
      <dl className="grid gap-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Receipt</dt>
          <dd className="font-mono font-semibold">{payload.receiptNo}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Code</dt>
          <dd className="font-mono">{code}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">School</dt>
          <dd>{payload.school.name}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Student</dt>
          <dd>
            {payload.student.name} ({payload.student.code})
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Paid</dt>
          <dd className="tabular-nums">{formatEtb(payload.total)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Method</dt>
          <dd>
            {payload.method} · {payload.gateway}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Paid at</dt>
          <dd>{formatDateTime(payload.paidAt)}</dd>
        </div>
      </dl>
      <a
        className="inline-block text-sm font-semibold text-brand-700 hover:underline"
        href={`/api/receipts/lookup/pdf?receiptNo=${encodeURIComponent(payload.receiptNo)}&code=${encodeURIComponent(code)}`}
      >
        Download PDF
      </a>
    </div>
  );
}

export function VerifyClient({ initialNumber, initialCode }: { initialNumber: string; initialCode: string }) {
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [lookingUp, setLookingUp] = useState(false);

  useEffect(() => {
    if (!window.location.hash || window.location.hash.length < 8) return;
    try {
      const decoded = decodeReceiptQr(window.location.href);
      void verifyReceiptSignature(keysFromEnv(), decoded).then((result) => {
        if (result.valid) setView({ kind: 'valid', payload: decoded.payload, code: result.verificationCode, source: 'qr' });
        else setView({ kind: 'invalid', reason: reasonText(result.reason) });
      });
    } catch {
      setView({ kind: 'invalid', reason: reasonText('malformed') });
    }
  }, []);

  async function lookup(formData: FormData) {
    setLookingUp(true);
    setView({ kind: 'idle' });
    const receiptNo = String(formData.get('receiptNo') ?? '').trim();
    const code = String(formData.get('code') ?? '').trim();
    try {
      const response = await fetch(`/api/receipts/lookup?receiptNo=${encodeURIComponent(receiptNo)}&code=${encodeURIComponent(code)}`, { cache: 'no-store' });
      const body = (await response.json()) as { message?: string; payload?: ReceiptPayload; verificationCode?: string; signatureValid?: boolean };
      if (!response.ok || !body.payload) {
        setView({ kind: 'error', message: body.message ?? 'No receipt matches this number and code' });
        return;
      }
      if (!body.signatureValid) {
        setView({ kind: 'invalid', reason: reasonText('bad_signature') });
        return;
      }
      setView({ kind: 'valid', payload: body.payload, code: body.verificationCode ?? code, source: 'lookup' });
    } catch {
      setView({ kind: 'error', message: 'Could not reach the server. Try the offline verifier if you have the QR code.' });
    } finally {
      setLookingUp(false);
    }
  }

  return (
    <div className="space-y-5">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup(new FormData(event.currentTarget));
        }}
      >
        <Field label="Receipt number" htmlFor="receiptNo">
          <Input id="receiptNo" name="receiptNo" required defaultValue={initialNumber} autoComplete="off" className="font-mono" />
        </Field>
        <Field label="Verification code" htmlFor="code" hint="8 characters printed on the receipt, for example 3FA9-0B1C">
          <Input id="code" name="code" required defaultValue={initialCode} autoComplete="off" className="font-mono uppercase" />
        </Field>
        <Button type="submit" className="w-full" disabled={lookingUp}>
          {lookingUp ? 'Looking up…' : 'Look up'}
        </Button>
      </form>
      {view.kind === 'valid' ? <ReceiptCard payload={view.payload} code={view.code} source={view.source} /> : null}
      {view.kind === 'invalid' ? <FormMessage state={{ error: view.reason }} /> : null}
      {view.kind === 'error' ? <FormMessage state={{ error: view.message }} /> : null}
    </div>
  );
}
