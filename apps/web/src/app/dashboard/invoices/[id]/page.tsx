import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { staffApi, ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/utils';
import { remindInvoiceAction } from '../actions';
import { CancelForm } from './cancel-form';

export const metadata: Metadata = { title: 'Invoice' };

interface InvoiceDetail {
  id: string;
  number: string;
  term: string | null;
  status: string;
  totalAmount: number;
  paidAmount: number;
  dueDate: string;
  payToken: string;
  student: { firstName: string; lastName: string; code: string; grade: string; section: string | null };
  lines: { id: string; description: string; amount: number }[];
  payments: { id: string; txRef: string; status: string; amount: number; method: string | null; createdAt: string }[];
  receipts: { id: string; receiptNo: string; issuedAt: string }[];
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let invoice: InvoiceDetail;
  try {
    invoice = await staffApi<InvoiceDetail>(`/invoices/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const balance = invoice.totalAmount - invoice.paidAmount;
  const canCancel = invoice.status === 'ISSUED' && invoice.paidAmount === 0;
  const canRemind = invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID';

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-gray-500">
          <Link href="/dashboard/invoices" className="text-brand-700">
            Invoices
          </Link>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-bold tracking-tight">{invoice.number}</h1>
          <StatusBadge status={invoice.status} />
        </div>
        <p className="mt-1 text-sm text-gray-600">
          {invoice.student.firstName} {invoice.student.lastName} ({invoice.student.code}) · Grade {invoice.student.grade}
          {invoice.student.section ? ` ${invoice.student.section}` : ''}
          {invoice.term ? ` · ${invoice.term}` : ''} · due {formatDate(invoice.dueDate)}
        </p>
      </div>
      <Card>
        <CardHeader title="Lines" />
        <Table>
          <thead>
            <tr>
              <Th>Description</Th>
              <Th>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id}>
                <Td>{line.description}</Td>
                <Td className="tabular-nums">{formatEtb(line.amount)}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-semibold">Balance</Td>
              <Td className="font-semibold tabular-nums">{formatEtb(balance)}</Td>
            </tr>
          </tbody>
        </Table>
      </Card>
      <div className="flex flex-wrap gap-3">
        <a className="text-sm font-semibold text-brand-700 hover:underline" href={`/pay/${encodeURIComponent(invoice.payToken)}`}>
          Open parent pay link
        </a>
        {canRemind ? (
          <form action={remindInvoiceAction.bind(null, invoice.id)}>
            <Button type="submit" variant="secondary" size="sm">
              Send reminder SMS
            </Button>
          </form>
        ) : null}
      </div>
      {canCancel ? <CancelForm invoiceId={invoice.id} /> : null}
      <Card>
        <CardHeader title="Payments" />
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Reference</Th>
              <Th>Amount</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {invoice.payments.length === 0 ? <EmptyRow colSpan={4}>No payment attempts.</EmptyRow> : null}
            {invoice.payments.map((payment) => (
              <tr key={payment.id}>
                <Td>{formatDateTime(payment.createdAt)}</Td>
                <Td className="font-mono text-xs">{payment.txRef}</Td>
                <Td className="tabular-nums">{formatEtb(payment.amount)}</Td>
                <Td>
                  <StatusBadge status={payment.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {invoice.receipts.length > 0 ? (
        <Card>
          <CardHeader title="Receipts" />
          <CardBody className="space-y-2">
            {invoice.receipts.map((receipt) => (
              <p key={receipt.id} className="text-sm">
                <a className="font-mono font-semibold text-brand-700 hover:underline" href={`/api/staff/receipts/${receipt.id}/pdf`}>
                  {receipt.receiptNo}
                </a>
                <span className="text-gray-500"> · {formatDateTime(receipt.issuedAt)}</span>
              </p>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
