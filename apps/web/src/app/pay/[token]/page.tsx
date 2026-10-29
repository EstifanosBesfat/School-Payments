import { formatEtb, formatEthiopianDate } from '@payment/shared';
import { CheckCircle2, FileDown } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/utils';
import { PayForm } from './pay-form';
import type { PayView } from './types';

export const metadata: Metadata = { title: 'Pay school fees', robots: { index: false } };

async function load(token: string): Promise<PayView> {
  try {
    return await api<PayView>(`/pay/${encodeURIComponent(token)}`, { auth: 'none' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await load(token);
  const { invoice, school, student } = view;
  const due = new Date(`${invoice.dueDate}T00:00:00+03:00`);

  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <header className="mb-5">
        <p className="text-sm text-gray-500">{school.city ?? 'Ethiopia'}</p>
        <h1 className="text-2xl font-bold tracking-tight">{school.name}</h1>
      </header>

      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-gray-500">Student · ተማሪ</p>
              <p className="font-semibold">
                {student.name} <span className="font-normal text-gray-500">({student.code})</span>
              </p>
              <p className="text-sm text-gray-500">
                Grade {student.grade}
                {student.section ? ` ${student.section}` : ''}
                {invoice.term ? ` · ${invoice.term}` : ''}
              </p>
            </div>
            <StatusBadge status={invoice.status} />
          </div>

          <ul className="divide-y divide-gray-100 border-y border-gray-100">
            {invoice.lines.map((line, index) => (
              <li key={`${line.description}-${index}`} className="flex justify-between py-2.5 text-sm">
                <span>{line.description}</span>
                <span className="font-medium tabular-nums">{formatEtb(line.amount)}</span>
              </li>
            ))}
          </ul>

          <dl className="space-y-1 text-sm">
            {invoice.paidAmount > 0 ? (
              <div className="flex justify-between text-gray-600">
                <dt>Already paid</dt>
                <dd className="tabular-nums">{formatEtb(invoice.paidAmount)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between text-base font-semibold">
              <dt>Amount due · የሚከፈል</dt>
              <dd className="tabular-nums">{formatEtb(invoice.balance)}</dd>
            </div>
            <div className="flex justify-between text-gray-600">
              <dt>Due date · የመጨረሻ ቀን</dt>
              <dd>
                {formatDate(due)} · {formatEthiopianDate(due, 'am')}
              </dd>
            </div>
            <div className="flex justify-between text-gray-500">
              <dt>Invoice</dt>
              <dd className="font-mono text-xs">{invoice.number}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {view.acceptingPayments && invoice.balance > 0 ? (
        <Card className="mt-4">
          <CardBody className="py-5">
            <PayForm token={token} amountLabel={formatEtb(invoice.balance)} gateway={view.gateway} />
          </CardBody>
        </Card>
      ) : invoice.status === 'PAID' ? (
        <Card className="mt-4 border-brand-500 bg-brand-50">
          <CardBody className="flex items-center gap-3 text-brand-800">
            <CheckCircle2 className="size-6 shrink-0" aria-hidden />
            <p className="font-medium">This invoice is fully paid. Thank you! · ተከፍሏል። እናመሰግናለን!</p>
          </CardBody>
        </Card>
      ) : (
        <Card className="mt-4">
          <CardBody className="text-sm text-gray-600">This invoice cannot be paid online right now. Please contact the school.</CardBody>
        </Card>
      )}

      {view.receipts.length > 0 ? (
        <Card className="mt-4">
          <CardBody className="space-y-3">
            <h2 className="font-semibold">Receipts · ደረሰኞች</h2>
            {view.receipts.map((receipt) => (
              <div key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
                <div>
                  <p className="font-mono text-sm font-semibold">{receipt.receiptNo}</p>
                  <p className="text-xs text-gray-500">
                    Code {receipt.verificationCode} · {formatDateTime(receipt.issuedAt)}
                  </p>
                </div>
                <a
                  href={`/api/pay/${encodeURIComponent(token)}/receipts/${receipt.id}/pdf`}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline"
                >
                  <FileDown className="size-4" aria-hidden /> PDF
                </a>
              </div>
            ))}
            <p className="text-xs text-gray-500">
              Anyone can check a receipt at{' '}
              <Link className="underline" href="/verify">
                /verify
              </Link>
              .
            </p>
          </CardBody>
        </Card>
      ) : null}
    </main>
  );
}
