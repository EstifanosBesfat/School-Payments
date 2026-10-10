import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/card';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Staff sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <Link href="/" className="mb-6 text-sm font-semibold text-brand-700">
        ← School Payments
      </Link>
      <Card>
        <CardBody className="space-y-6 py-6">
          <div>
            <h1 className="text-xl font-semibold">Staff sign in</h1>
            <p className="mt-1 text-sm text-gray-500">For school administrators, accountants and platform staff. Parents use the parent portal.</p>
          </div>
          <LoginForm next={next} />
        </CardBody>
      </Card>
    </main>
  );
}
