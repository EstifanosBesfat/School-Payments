import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import { Pagination } from '@/components/pagination';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Paginated, staffApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { ChainButton } from './chain-button';

export const metadata: Metadata = { title: 'Receipts' };

interface ReceiptRow {
  id: string;
  receiptNo: string;
  verificationCode: string;
  issuedAt: string;
  pdfKey: string | null;
  payment: { amount: number; method: string | null; payerName: string; status: string };
  invoice: { number: string; student: { code: string; firstName: string; lastName: string } };
}

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const page = Number(query.page ?? '1') || 1;
  const receipts = await staffApi<Paginated<ReceiptRow>>('/receipts', {
    query: { page, pageSize: 25, search: query.search, from: query.from, to: query.to },
  });
  const exportQuery = new URLSearchParams();
  if (query.from) exportQuery.set('from', query.from);
  if (query.to) exportQuery.set('to', query.to);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Receipts</h1>
        <div className="flex flex-wrap items-center gap-3">
          <ChainButton />
          <a
            className="inline-flex h-8 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-900 hover:bg-gray-50"
            href={`/api/staff/receipts/export.csv?${exportQuery.toString()}`}
          >
            Export CSV
          </a>
        </div>
      </div>
      <Card>
        <CardHeader title="Issued receipts" description="Signed with Ed25519 and chained per school. CSV cells that look like formulas are escaped." />
        <form className="flex flex-wrap gap-3 px-5 py-3" method="get">
          <Field label="Search" htmlFor="search" className="min-w-48 flex-1">
            <Input id="search" name="search" defaultValue={query.search} placeholder="Receipt, invoice or student" />
          </Field>
          <Field label="From" htmlFor="from">
            <Input id="from" name="from" type="date" defaultValue={query.from} />
          </Field>
          <Field label="To" htmlFor="to">
            <Input id="to" name="to" type="date" defaultValue={query.to} />
          </Field>
          <button type="submit" className="mt-6 text-sm font-semibold text-brand-700">
            Filter
          </button>
        </form>
        <Table>
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Student</Th>
              <Th>Amount</Th>
              <Th>Issued</Th>
            </tr>
          </thead>
          <tbody>
            {receipts.items.length === 0 ? <EmptyRow colSpan={4}>No receipts match.</EmptyRow> : null}
            {receipts.items.map((receipt) => (
              <tr key={receipt.id}>
                <Td>
                  <a className="font-mono text-sm font-semibold text-brand-700 hover:underline" href={`/api/staff/receipts/${receipt.id}/pdf`}>
                    {receipt.receiptNo}
                  </a>
                  <p className="text-xs text-gray-500">Code {receipt.verificationCode}</p>
                </Td>
                <Td>
                  {receipt.invoice.student.firstName} {receipt.invoice.student.lastName}
                  <span className="block text-xs text-gray-500">{receipt.invoice.number}</span>
                </Td>
                <Td className="tabular-nums">{formatEtb(receipt.payment.amount)}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(receipt.issuedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Pagination
          path="/dashboard/receipts"
          page={receipts.page}
          pageSize={receipts.pageSize}
          total={receipts.total}
          query={{ search: query.search, from: query.from, to: query.to }}
        />
      </Card>
    </div>
  );
}
