import { formatEtb } from '@payment/shared';
import { FileDown } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import { parentLogoutAction } from './actions';

export interface ParentOverviewData {
  phone: string;
  students: {
    id: string;
    name: string;
    code: string;
    grade: string;
    section: string | null;
    school: string;
    invoices: {
      id: string;
      number: string;
      term: string | null;
      status: string;
      totalAmount: number;
      paidAmount: number;
      dueDate: string;
      payToken: string;
      balance: number;
      receipts: { id: string; receiptNo: string; issuedAt: string; verificationCode: string }[];
    }[];
  }[];
}

export function ParentOverview({ overview }: { overview: ParentOverviewData }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Your children · የእርስዎ ልጆች</h1>
          <p className="mt-1 text-sm text-gray-500">Signed in with your phone. Codes expire after two hours.</p>
        </div>
        <form action={parentLogoutAction}>
          <Button type="submit" variant="secondary" size="sm">
            Sign out
          </Button>
        </form>
      </div>

      {overview.students.length === 0 ? (
        <Card>
          <CardBody className="py-10 text-center text-sm text-gray-600">No students are linked to this phone number. Ask the school to add you as a guardian.</CardBody>
        </Card>
      ) : (
        overview.students.map((student) => (
          <Card key={student.id}>
            <CardHeader
              title={`${student.name} (${student.code})`}
              description={`${student.school} · Grade ${student.grade}${student.section ? ` ${student.section}` : ''}`}
            />
            <CardBody className="space-y-3">
              {student.invoices.length === 0 ? <p className="text-sm text-gray-500">No invoices yet.</p> : null}
              {student.invoices.map((invoice) => (
                <div key={invoice.id} className="rounded-lg border border-gray-200 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {invoice.term ?? 'Fees'} <span className="font-normal text-gray-500">· {invoice.number}</span>
                      </p>
                      <p className="text-sm text-gray-500">Due {formatDate(invoice.dueDate)}</p>
                    </div>
                    <StatusBadge status={invoice.status} />
                  </div>
                  <p className="mt-2 text-sm">
                    {formatEtb(invoice.paidAmount)} paid of {formatEtb(invoice.totalAmount)}
                    {invoice.balance > 0 ? ` · ${formatEtb(invoice.balance)} due` : ''}
                  </p>
                  {invoice.balance > 0 && (invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID') ? (
                    <LinkButton href={`/pay/${encodeURIComponent(invoice.payToken)}`} size="sm" className="mt-3">
                      Pay now · ክፈል
                    </LinkButton>
                  ) : null}
                  {invoice.receipts.length > 0 ? (
                    <ul className="mt-3 space-y-1 text-sm">
                      {invoice.receipts.map((receipt) => (
                        <li key={receipt.id}>
                          <Link className="inline-flex items-center gap-1.5 font-medium text-brand-700 hover:underline" href={`/verify?no=${encodeURIComponent(receipt.receiptNo)}&code=${encodeURIComponent(receipt.verificationCode)}`}>
                            <FileDown className="size-3.5" aria-hidden />
                            {receipt.receiptNo}
                          </Link>
                          <span className="text-gray-500"> · {receipt.verificationCode}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}
