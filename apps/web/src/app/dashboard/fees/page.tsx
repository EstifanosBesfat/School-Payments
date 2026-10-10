import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { staffApi } from '@/lib/api';
import { setFeeItemActiveAction } from './actions';
import { CreateFeeForm } from './fee-form';

export const metadata: Metadata = { title: 'Fee items' };

interface FeeItem {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  isActive: boolean;
}

export default async function FeesPage() {
  const items = await staffApi<FeeItem[]>('/fee-items', { query: { includeInactive: 'true' } });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Fee items</h1>
      <Card>
        <CardHeader title="Catalogue" description="Amounts are in Ethiopian Birr. Invoices copy the amount at issue time." />
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Amount</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? <EmptyRow colSpan={4}>No fee items yet.</EmptyRow> : null}
            {items.map((item) => (
              <tr key={item.id}>
                <Td>
                  <p className="font-medium text-gray-900">{item.name}</p>
                  {item.description ? <p className="text-xs text-gray-500">{item.description}</p> : null}
                </Td>
                <Td className="tabular-nums">{formatEtb(item.amount)}</Td>
                <Td>{item.isActive ? 'Active' : 'Inactive'}</Td>
                <Td>
                  <form action={setFeeItemActiveAction.bind(null, item.id, !item.isActive)}>
                    <Button type="submit" variant="ghost" size="sm">
                      {item.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Add a fee item" />
        <CardBody>
          <CreateFeeForm />
        </CardBody>
      </Card>
    </div>
  );
}
