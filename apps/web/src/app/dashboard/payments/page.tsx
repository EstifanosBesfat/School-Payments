import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import { Pagination } from '@/components/pagination';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/form';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Paginated, staffApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { VerifyButton } from './verify-button';

export const metadata: Metadata = { title: 'Payments' };

interface PaymentRow {
  id: string;
  txRef: string;
  status: string;
  amount: number;
  method: string | null;
  createdAt: string;
  invoice: { number: string; student: { firstName: string; lastName: string; code: string } };
  receipt: { id: string; receiptNo: string } | null;
}

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  const query = await searchParams;
  const page = Number(query.page ?? '1') || 1;
  const payments = await staffApi<Paginated<PaymentRow>>('/payments', { query: { page, pageSize: 25, status: query.status } });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Payments</h1>
      <Card>
        <CardHeader title="Attempts" description="Only a server-side gateway verify can mark a payment succeeded." />
        <form className="flex flex-wrap gap-3 px-5 py-3" method="get">
          <Field label="Status" htmlFor="status" className="w-48">
            <Select id="status" name="status" defaultValue={query.status ?? ''}>
              <option value="">Any</option>
              <option value="PENDING">Pending</option>
              <option value="SUCCEEDED">Succeeded</option>
              <option value="FAILED">Failed</option>
              <option value="REVIEW">Review</option>
            </Select>
          </Field>
          <button type="submit" className="mt-6 text-sm font-semibold text-brand-700">
            Filter
          </button>
        </form>
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Student</Th>
              <Th>Amount</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {payments.items.length === 0 ? <EmptyRow colSpan={5}>No payments match.</EmptyRow> : null}
            {payments.items.map((payment) => (
              <tr key={payment.id}>
                <Td className="whitespace-nowrap">{formatDateTime(payment.createdAt)}</Td>
                <Td>
                  {payment.invoice.student.firstName} {payment.invoice.student.lastName}
                  <span className="block text-xs text-gray-500">
                    {payment.invoice.number}
                    {payment.method ? ` · ${payment.method}` : ''}
                  </span>
                </Td>
                <Td className="tabular-nums">{formatEtb(payment.amount)}</Td>
                <Td>
                  <StatusBadge status={payment.status} />
                  {payment.receipt ? (
                    <a className="mt-1 block text-xs font-medium text-brand-700" href={`/api/staff/receipts/${payment.receipt.id}/pdf`}>
                      {payment.receipt.receiptNo}
                    </a>
                  ) : null}
                </Td>
                <Td>{payment.status === 'PENDING' || payment.status === 'REVIEW' ? <VerifyButton paymentId={payment.id} /> : null}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Pagination path="/dashboard/payments" page={payments.page} pageSize={payments.pageSize} total={payments.total} query={{ status: query.status }} />
      </Card>
    </div>
  );
}
