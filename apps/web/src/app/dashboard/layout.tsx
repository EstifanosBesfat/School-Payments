import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { type Me, staffApi } from '@/lib/api';
import { logoutAction } from '../login/actions';
import { DashboardNav } from './nav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const me = await staffApi<Me>('/auth/me');
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="border-b border-gray-200 bg-white lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-3 px-4 py-4 lg:block">
          <Link href="/dashboard" className="font-semibold text-brand-800">
            {me.school?.name ?? 'School Payments'}
          </Link>
          <form action={logoutAction} className="lg:mt-4">
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
        <DashboardNav role={me.role} />
        <p className="hidden px-5 pb-4 text-xs text-gray-500 lg:block">
          {me.name} · {me.role.replace('_', ' ').toLowerCase()}
        </p>
      </aside>
      <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}
