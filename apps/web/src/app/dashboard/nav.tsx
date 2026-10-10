'use client';

import {
  Building2,
  FileText,
  LayoutDashboard,
  Receipt,
  Scale,
  Settings,
  Users,
  Wallet,
  CreditCard,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const SCHOOL_LINKS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/students', label: 'Students', icon: Users },
  { href: '/dashboard/fees', label: 'Fees', icon: Wallet },
  { href: '/dashboard/invoices', label: 'Invoices', icon: FileText },
  { href: '/dashboard/payments', label: 'Payments', icon: CreditCard },
  { href: '/dashboard/receipts', label: 'Receipts', icon: Receipt },
  { href: '/dashboard/reconciliation', label: 'Reconciliation', icon: Scale },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, adminOnly: true },
];

const PLATFORM_LINKS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/schools', label: 'Schools', icon: Building2 },
  { href: '/dashboard/reconciliation', label: 'Reconciliation', icon: Scale },
];

export function DashboardNav({ role }: { role: string }) {
  const pathname = usePathname();
  const links = role === 'PLATFORM_ADMIN' ? PLATFORM_LINKS : SCHOOL_LINKS.filter((link) => !link.adminOnly || role === 'SCHOOL_ADMIN');
  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {links.map(({ href, label, icon: Icon }) => {
        const active = href === '/dashboard' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium',
              active ? 'bg-brand-100 text-brand-800' : 'text-gray-700 hover:bg-gray-100',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
