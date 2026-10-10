import type { Metadata } from 'next';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { staffApi } from '@/lib/api';
import { BulkInvoiceForm } from './form';

export const metadata: Metadata = { title: 'Bulk invoices' };

export default async function BulkInvoicePage() {
  const [grades, feeItems] = await Promise.all([
    staffApi<{ grade: string; section: string | null; students: number }[]>('/students/grades'),
    staffApi<{ id: string; name: string; amount: number }[]>('/fee-items'),
  ]);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Bulk invoices</h1>
      <Card>
        <CardHeader title="Issue to a class" description="Students who already have an invoice for the same term are skipped." />
        <CardBody>
          <BulkInvoiceForm grades={grades} feeItems={feeItems} />
        </CardBody>
      </Card>
    </div>
  );
}
