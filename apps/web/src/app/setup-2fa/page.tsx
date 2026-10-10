import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { type Me, staffApi } from '@/lib/api';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up two-factor authentication' };

export default async function SetupTwoFactorPage() {
  const me = await staffApi<Me>('/auth/me');
  if (me.totpEnabled) redirect('/dashboard');
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <Card>
        <CardBody className="space-y-5 py-6">
          <div>
            <h1 className="text-xl font-semibold">Protect your account</h1>
            <p className="mt-1 text-sm text-gray-500">
              {me.name}, staff accounts that handle school money must use two-factor authentication. You will need the code from your phone each time you sign in.
            </p>
          </div>
          <SetupForm />
        </CardBody>
      </Card>
    </main>
  );
}
