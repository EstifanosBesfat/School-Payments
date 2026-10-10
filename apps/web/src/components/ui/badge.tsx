import { cn } from '@/lib/utils';

const tones = {
  gray: 'bg-gray-100 text-gray-700',
  green: 'bg-brand-100 text-brand-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-sky-100 text-sky-800',
} as const;

const STATUS_TONES: Record<string, keyof typeof tones> = {
  PAID: 'green',
  SUCCEEDED: 'green',
  ACTIVE: 'green',
  SENT: 'green',
  RESOLVED: 'green',
  ISSUED: 'blue',
  PENDING: 'amber',
  PARTIALLY_PAID: 'amber',
  ONBOARDING: 'amber',
  REVIEW: 'red',
  OPEN: 'red',
  FAILED: 'red',
  SUSPENDED: 'red',
  CANCELLED: 'gray',
  REFUNDED: 'gray',
  REVERSED: 'gray',
  DRAFT: 'gray',
};

export function Badge({ tone = 'gray', className, children }: { tone?: keyof typeof tones; className?: string; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'gray'}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}
