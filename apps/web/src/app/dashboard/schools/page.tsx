import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Me, staffApi } from '@/lib/api';
import { CreateSchoolForm, StatusForm } from './forms';

export const metadata: Metadata = { title: 'Schools' };

interface SchoolRow {
  id: string;
  name: string;
  code: string;
  status: string;
  city: string | null;
  contactEmail: string;
  settlementSummary: string | null;
  _count: { students: number; invoices: number };
}

export default async function SchoolsPage() {
  const me = await staffApi<Me>('/auth/me');
  if (me.role !== 'PLATFORM_ADMIN') redirect('/dashboard');
  const schools = await staffApi<SchoolRow[]>('/schools');
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Schools</h1>
      <Card>
        <CardHeader title="Tenants" description="A school must register a payout account before it can be set Active on the live gateway." />
        <Table>
          <thead>
            <tr>
              <Th>School</Th>
              <Th>Students</Th>
              <Th>Status</Th>
              <Th>Change</Th>
            </tr>
          </thead>
          <tbody>
            {schools.length === 0 ? <EmptyRow colSpan={4}>No schools yet.</EmptyRow> : null}
            {schools.map((school) => (
              <tr key={school.id}>
                <Td>
                  <p className="font-medium">{school.name}</p>
                  <p className="text-xs text-gray-500">
                    {school.code}
                    {school.city ? ` · ${school.city}` : ''}
                    {school.settlementSummary ? ` · ${school.settlementSummary}` : ' · no payout account'}
                  </p>
                </Td>
                <Td>{school._count.students}</Td>
                <Td>
                  <StatusBadge status={school.status} />
                </Td>
                <Td>
                  <StatusForm schoolId={school.id} status={school.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Onboard a school" />
        <CardBody>
          <CreateSchoolForm />
        </CardBody>
      </Card>
    </div>
  );
}
