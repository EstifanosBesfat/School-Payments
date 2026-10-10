import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { PARENT_COOKIE } from '@/lib/session';
import { ParentOtpForm } from './otp-form';
import { ParentOverview, type ParentOverviewData } from './overview';

export const metadata: Metadata = { title: 'Parent portal', robots: { index: false } };

export default async function ParentPage() {
  const token = (await cookies()).get(PARENT_COOKIE)?.value;
  if (token) {
    try {
      const overview = await api<ParentOverviewData>('/parent/overview', { auth: 'parent' });
      return (
        <main className="mx-auto max-w-2xl px-4 py-10">
          <ParentOverview overview={overview} />
        </main>
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <Link href="/" className="mb-6 text-sm font-semibold text-brand-700">
        ← School Payments
      </Link>
      <Card>
        <CardBody className="space-y-5 py-6">
          <div>
            <h1 className="text-xl font-semibold">Parent portal · የወላጅ መግቢያ</h1>
            <p className="mt-1 text-sm text-gray-500">We send a one-time code to the phone number the school has on file. We never ask for a password.</p>
          </div>
          <ParentOtpForm />
        </CardBody>
      </Card>
    </main>
  );
}
