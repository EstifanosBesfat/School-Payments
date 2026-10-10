import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/card';
import { VerifyClient } from './verify-client';

export const metadata: Metadata = { title: 'Verify a receipt' };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ no?: string; code?: string }> }) {
  const { no, code } = await searchParams;
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <Link href="/" className="mb-6 inline-block text-sm font-semibold text-brand-700">
        ← School Payments
      </Link>
      <h1 className="text-2xl font-bold tracking-tight">Verify a receipt · ደረሰኝ ያረጋግጡ</h1>
      <p className="mt-2 text-sm text-gray-600">
        Scan the QR on the paper or PDF, or type the receipt number and the 8-character code. Verification uses the school’s public key in your browser — the payload in the QR never has to leave your device.
      </p>
      <Card className="mt-6">
        <CardBody className="py-5">
          <VerifyClient initialNumber={no ?? ''} initialCode={code ?? ''} />
        </CardBody>
      </Card>
      <p className="mt-4 text-sm text-gray-500">
        Download a{' '}
        <a className="font-medium text-brand-700 underline" href="/api/receipts/offline-verifier.html">
          self-contained verifier
        </a>{' '}
        to check receipts with no internet.
      </p>
    </main>
  );
}
