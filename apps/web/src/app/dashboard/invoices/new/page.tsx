import type { Metadata } from 'next';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { type Paginated, staffApi } from '@/lib/api';
import { InvoiceCreateForm } from './form';

export const metadata: Metadata = { title: 'New invoice' };

interface StudentOption {
  id: string;
  code: string;
  firstName: string;
  lastName: string;
  grade: string;
  section: string | null;
}

interface FeeItem {
  id: string;
  name: string;
  amount: number;
}

export default async function NewInvoicePage() {
  const [students, feeItems] = await Promise.all([
    staffApi<Paginated<StudentOption>>('/students', { query: { pageSize: 100 } }),
    staffApi<FeeItem[]>('/fee-items'),
  ]);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">New invoice</h1>
      <Card>
        <CardHeader title="Issue to one student" description="Parents receive an SMS with a pay link when Notify is checked." />
        <CardBody>
          <InvoiceCreateForm students={students.items} feeItems={feeItems} />
        </CardBody>
      </Card>
    </div>
  );
}
