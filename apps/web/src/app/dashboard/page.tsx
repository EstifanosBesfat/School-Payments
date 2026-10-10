import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader, Stat } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Me, type Paginated, staffApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Overview' };

/** Ledger balances from the API are debits minus credits. Fee revenue is credit-normal, so earned fees are the negation. */
function creditNormal(balance: number): number {
  return -balance;
}

interface SchoolRow {
  id: string;
  name: string;
  code: string;
  status: string;
  city: string | null;
  _count: { students: number; invoices: number };
}

interface PaymentRow {
  id: string;
  txRef: string;
  status: string;
  amount: number;
  method: string | null;
  createdAt: string;
  invoice: { number: string; student: { firstName: string; lastName: string; code: string } };
}

export default async function DashboardHomePage() {
  const me = await staffApi<Me>('/auth/me');
  if (me.role === 'PLATFORM_ADMIN') {
    const schools = await staffApi<SchoolRow[]>('/schools');
    const active = schools.filter((school) => school.status === 'ACTIVE').length;
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Platform</h1>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Schools" value={String(schools.length)} />
          <Stat label="Active" value={String(active)} />
          <Stat label="Onboarding / suspended" value={String(schools.length - active)} />
        </div>
        <Card>
          <CardHeader title="Schools" action={<Link className="text-sm font-semibold text-brand-700" href="/dashboard/schools">Manage</Link>} />
          <Table>
            <thead>
              <tr>
                <Th>School</Th>
                <Th>Status</Th>
                <Th>Students</Th>
                <Th>Invoices</Th>
              </tr>
            </thead>
            <tbody>
              {schools.length === 0 ? <EmptyRow colSpan={4}>No schools yet.</EmptyRow> : null}
              {schools.map((school) => (
                <tr key={school.id}>
                  <Td>
                    <p className="font-medium text-gray-900">{school.name}</p>
                    <p className="text-xs text-gray-500">
                      {school.code}
                      {school.city ? ` · ${school.city}` : ''}
                    </p>
                  </Td>
                  <Td>
                    <StatusBadge status={school.status} />
                  </Td>
                  <Td>{school._count.students}</Td>
                  <Td>{school._count.invoices}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    );
  }

  const [balances, payments] = await Promise.all([
    staffApi<Record<string, number>>('/school/ledger/balances'),
    staffApi<Paginated<PaymentRow>>('/payments', { query: { pageSize: 8 } }),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Families owe" value={formatEtb(balances.STUDENT_RECEIVABLE ?? 0)} hint="Open invoice balances" />
        <Stat label="Fee revenue" value={formatEtb(creditNormal(balances.FEE_REVENUE ?? 0))} hint="Earned on issued invoices" />
        <Stat label="At the gateway" value={formatEtb(balances.GATEWAY_CLEARING ?? 0)} hint="Settles to the school bank account" />
      </div>
      <Card>
        <CardHeader title="Recent payments" action={<Link className="text-sm font-semibold text-brand-700" href="/dashboard/payments">All payments</Link>} />
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Student</Th>
              <Th>Amount</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {payments.items.length === 0 ? <EmptyRow colSpan={4}>No payments yet.</EmptyRow> : null}
            {payments.items.map((payment) => (
              <tr key={payment.id}>
                <Td className="whitespace-nowrap">{formatDateTime(payment.createdAt)}</Td>
                <Td>
                  {payment.invoice.student.firstName} {payment.invoice.student.lastName}
                  <span className="block text-xs text-gray-500">{payment.invoice.number}</span>
                </Td>
                <Td className="tabular-nums">{formatEtb(payment.amount)}</Td>
                <Td>
                  <StatusBadge status={payment.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
