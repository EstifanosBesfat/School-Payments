import Link from 'next/link';
import { LinkButton } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 text-center">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-2 text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm text-gray-600">This link may have expired, or the page does not exist.</p>
      <div className="mt-6 flex justify-center gap-3">
        <LinkButton href="/">Home</LinkButton>
        <Link href="/verify" className="inline-flex h-10 items-center text-sm font-semibold text-brand-700">
          Verify a receipt
        </Link>
      </div>
    </main>
  );
}
