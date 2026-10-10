import type { Metadata } from 'next';
import Link from 'next/link';
import { ReturnPoller } from './return-poller';

export const metadata: Metadata = { title: 'Payment result', robots: { index: false } };

export default async function PayReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ tx?: string }>;
}) {
  const { token } = await params;
  const { tx } = await searchParams;
  if (!tx) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Missing payment reference</h1>
        <p className="mt-2 text-sm text-gray-600">Go back to your invoice and try again.</p>
        <Link className="mt-4 inline-block font-semibold text-brand-700" href={`/pay/${encodeURIComponent(token)}`}>
          Open invoice
        </Link>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <ReturnPoller token={token} txRef={tx} />
    </main>
  );
}
