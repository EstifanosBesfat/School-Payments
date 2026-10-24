'use client';

import { formatEtb } from '@payment/shared';
import { CheckCircle2, FileDown, LoaderCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import type { PayStatus } from '../types';

export function ReturnPoller({ token, txRef, mode = 'return' }: { token: string; txRef: string; mode?: 'return' | 'phone_prompt' }) {
  const [status, setStatus] = useState<PayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`/api/pay/${encodeURIComponent(token)}/status?tx=${encodeURIComponent(txRef)}`, { cache: 'no-store' });
        const body = (await response.json()) as PayStatus & { message?: string };
        if (!response.ok) throw new Error(body.message ?? 'Could not load payment status');
        if (cancelled) return;
        setStatus(body);
        setError(null);
        const waiting =
          body.rechecking === true ||
          body.payment.status === 'PENDING' ||
          (body.payment.status === 'SUCCEEDED' && body.receipt !== null && !body.receipt.pdfReady);
        if (waiting) timer = setTimeout(poll, body.payment.status === 'FAILED' ? 4000 : 1500);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load payment status');
        if (!cancelled) timer = setTimeout(poll, 2500);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, txRef]);

  if (error && !status) {
    return (
      <Card>
        <CardBody className="space-y-3 py-8 text-center">
          <LoaderCircle className="mx-auto size-8 animate-spin text-brand-700" aria-hidden />
          <p className="text-sm text-gray-600">{error}</p>
        </CardBody>
      </Card>
    );
  }

  if (!status || status.payment.status === 'PENDING' || (status.payment.status === 'FAILED' && status.rechecking)) {
    return (
      <Card>
        <CardBody className="space-y-3 py-10 text-center">
          <LoaderCircle className="mx-auto size-8 animate-spin text-brand-700" aria-hidden />
          <h1 className="text-lg font-semibold">{mode === 'phone_prompt' ? 'Approve on your phone · በስልክዎ ያጽድቁ' : 'Confirming your payment…'}</h1>
          <p className="text-sm text-gray-600">
            {mode === 'phone_prompt'
              ? 'A request was sent to your phone. Approve it, then stay on this page. · ጥያቄው ወደ ስልክዎ ተልኳል። እባክዎ ያጽድቁ።'
              : 'Do not close this page. We are checking with the payment gateway. · እባክዎ ይጠብቁ።'}
          </p>
        </CardBody>
      </Card>
    );
  }

  if (status.payment.status === 'SUCCEEDED') {
    return (
      <Card className="border-brand-500">
        <CardBody className="space-y-4 py-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-7 shrink-0 text-brand-700" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold text-brand-800">Payment received · ክፍያ ተቀብሏል</h1>
              <p className="mt-1 text-sm text-gray-600">
                {formatEtb(status.payment.amount)} from {status.payment.payer}
                {status.payment.method ? ` via ${status.payment.method}` : ''}.
              </p>
            </div>
          </div>
          {status.receipt ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="font-mono text-sm font-semibold">{status.receipt.receiptNo}</p>
              <p className="text-xs text-gray-500">Verification code {status.receipt.verificationCode}</p>
              {status.receipt.pdfReady ? (
                <a
                  href={`/api/pay/${encodeURIComponent(token)}/receipts/${status.receipt.id}/pdf`}
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline"
                >
                  <FileDown className="size-4" aria-hidden /> Download signed PDF
                </a>
              ) : (
                <p className="mt-2 text-sm text-gray-500">Preparing your signed PDF…</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">Issuing your signed receipt…</p>
          )}
          <div className="flex flex-wrap gap-3">
            <LinkButton href={`/pay/${encodeURIComponent(token)}`} variant="secondary">
              Back to invoice
            </LinkButton>
            {status.receipt ? (
              <LinkButton href={`/verify?no=${encodeURIComponent(status.receipt.receiptNo)}&code=${encodeURIComponent(status.receipt.verificationCode)}`} variant="secondary">
                Verify receipt
              </LinkButton>
            ) : null}
          </div>
        </CardBody>
      </Card>
    );
  }

  if (status.payment.status === 'REVIEW') {
    return (
      <Card>
        <CardBody className="space-y-3 py-6">
          <h1 className="text-lg font-semibold">Payment under review</h1>
          <p className="text-sm text-gray-600">The school will confirm this payment. Keep your SMS and this page if you have a screenshot of the transfer.</p>
          <StatusBadge status={status.payment.status} />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-6">
        <div className="flex items-start gap-3">
          <XCircle className="mt-0.5 size-7 shrink-0 text-red-600" aria-hidden />
          <div>
            <h1 className="text-xl font-semibold">Payment not completed</h1>
            <p className="mt-1 text-sm text-gray-600">No money was taken, or the attempt failed. You can try again from the invoice.</p>
          </div>
        </div>
        <StatusBadge status={status.payment.status} />
        <Link className="inline-block font-semibold text-brand-700" href={`/pay/${encodeURIComponent(token)}`}>
          Try again
        </Link>
      </CardBody>
    </Card>
  );
}
