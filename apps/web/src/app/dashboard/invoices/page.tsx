import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Pagination } from '@/components/pagination';
import { StatusBadge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Paginated, staffApi } from '@/lib/api';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Invoices' };

interface InvoiceRow {
  id: string;
  number: string;
  term: string | null;
  status: string;
  totalAmount: number;
  paidAmount: number;
  dueDate: string;
  student: { firstName: string; lastName: string; code: string; grade: string; section: string | null };
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; status?: string; overdue?: string }>;
}) {
  const query = await searchParams;
  const page = Number(query.page ?? '1') || 1;
  const invoices = await staffApi<Paginated<InvoiceRow>>('/invoices', {
    query: { page, pageSize: 25, search: query.search, status: query.status, overdue: query.overdue === '1' ? 'true' : undefined },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
        <div className="flex gap-2">
          <LinkButton href="/dashboard/invoices/new" size="sm">
            New invoice
          </LinkButton>
          <LinkButton href="/dashboard/invoices/bulk" size="sm" variant="secondary">
            Bulk by class
          </LinkButton>
        </div>
      </div>
      <Card>
        <CardHeader title="Issued invoices" />
        <form className="flex flex-wrap gap-3 px-5 py-3" method="get">
          <Field label="Search" htmlFor="search" className="min-w-48 flex-1">
            <Input id="search" name="search" defaultValue={query.search} placeholder="Number or student" />
          </Field>
          <Field label="Status" htmlFor="status" className="w-44">
            <Select id="status" name="status" defaultValue={query.status ?? ''}>
              <option value="">Any</option>
              <option value="ISSUED">Issued</option>
              <option value="PARTIALLY_PAID">Partially paid</option>
              <option value="PAID">Paid</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          </Field>
          <label className="mt-7 flex items-center gap-2 text-sm">
            <input type="checkbox" name="overdue" value="1" defaultChecked={query.overdue === '1'} />
            Overdue only
          </label>
          <button type="submit" className="mt-6 text-sm font-semibold text-brand-700">
            Filter
          </button>
        </form>
        <Table>
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Student</Th>
              <Th>Due</Th>
              <Th>Balance</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.items.length === 0 ? <EmptyRow colSpan={5}>No invoices match.</EmptyRow> : null}
            {invoices.items.map((invoice) => (
              <tr key={invoice.id}>
                <Td>
                  <Link className="font-mono text-sm font-semibold text-brand-700 hover:underline" href={`/dashboard/invoices/${invoice.id}`}>
                    {invoice.number}
                  </Link>
                  {invoice.term ? <p className="text-xs text-gray-500">{invoice.term}</p> : null}
                </Td>
                <Td>
                  {invoice.student.firstName} {invoice.student.lastName}
                  <span className="block text-xs text-gray-500">
                    {invoice.student.code} · {invoice.student.grade}
                    {invoice.student.section ? ` ${invoice.student.section}` : ''}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">{formatDate(invoice.dueDate)}</Td>
                <Td className="tabular-nums">{formatEtb(invoice.totalAmount - invoice.paidAmount)}</Td>
                <Td>
                  <StatusBadge status={invoice.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Pagination
          path="/dashboard/invoices"
          page={invoices.page}
          pageSize={invoices.pageSize}
          total={invoices.total}
          query={{ search: query.search, status: query.status, overdue: query.overdue }}
        />
      </Card>
    </div>
  );
}
