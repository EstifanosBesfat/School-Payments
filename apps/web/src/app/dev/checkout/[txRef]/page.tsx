import { formatEtb } from '@payment/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { CheckoutForm } from './checkout-form';

export const metadata: Metadata = { title: 'Mock checkout', robots: { index: false, follow: false } };

interface MockTx {
  txRef: string;
  amount: number;
  currency: string;
  status: string;
  title: string;
  description: string;
  customerName: string;
}

export default async function MockCheckoutPage({ params }: { params: Promise<{ txRef: string }> }) {
  const { txRef } = await params;
  let transaction: MockTx;
  try {
    transaction = await api<MockTx>(`/dev/mock-gateway/${encodeURIComponent(txRef)}`, { auth: 'none' });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-700">Development gateway · not Chapa</p>
      <Card>
        <CardBody className="space-y-4 py-6">
          <div>
            <h1 className="text-xl font-semibold">{transaction.title}</h1>
            <p className="mt-1 text-sm text-gray-600">{transaction.description}</p>
          </div>
          <p className="text-3xl font-bold tabular-nums">{formatEtb(transaction.amount)}</p>
          <p className="text-sm text-gray-500">Payer: {transaction.customerName}</p>
          {transaction.status === 'pending' ? (
            <CheckoutForm txRef={txRef} />
          ) : (
            <p className="text-sm text-gray-600">This mock payment is already {transaction.status}.</p>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
