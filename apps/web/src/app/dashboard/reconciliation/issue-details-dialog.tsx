'use client';

import { useState } from 'react';
import { Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/utils';

interface IssueDetailsDialogProps {
  issue: {
    id: string;
    kind: string;
    status: string;
    txRef: string | null;
    gatewayReference: string | null;
    createdAt: string;
    details: unknown;
    schoolId: string | null;
  };
}

export function IssueDetailsDialog({ issue }: IssueDetailsDialogProps) {
  const [open, setOpen] = useState(false);
  const details = issue.details as Record<string, any> | null;

  const getActionItems = () => {
    switch (issue.kind) {
      case 'status_mismatch':
        return [
          'Check Chapa dashboard to confirm transaction status',
          'Verify the payment in your database',
          'If Chapa shows success, manually attach the payment using the transaction reference',
          'Document the resolution in the notes field',
        ];
      case 'gateway_tx_unknown':
        return [
          'This typically happens when parents retry inside Chapa\'s checkout page',
          'Copy the gateway reference from details below',
          'Go to the relevant invoice in your dashboard',
          'Use "Attach External Payment" to link this transaction',
          'Verify amount matches the invoice balance',
        ];
      case 'amount_mismatch':
        return [
          'CRITICAL: Amount discrepancy detected',
          'Compare amounts in Chapa dashboard vs your database',
          'Check for duplicate charges or partial refunds',
          'Contact Chapa support if needed',
          'Issue refund if parent was overcharged',
        ];
      case 'missing_at_gateway':
        return [
          'Database shows success but Chapa doesn\'t have it',
          'Check if this was a test transaction',
          'Verify with Chapa support',
          'May need to reverse the ledger entry',
        ];
      default:
        return ['Review the details below', 'Investigate the root cause', 'Document your findings'];
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Eye className="mr-1 h-3 w-3" />
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Issue Details</DialogTitle>
          <DialogDescription>
            Complete information about this reconciliation issue
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Overview */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <h3 className="font-semibold text-gray-900">Overview</h3>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-gray-600">Issue Type</dt>
                <dd className="mt-1 font-mono text-sm font-semibold text-gray-900">
                  {issue.kind.replace(/_/g, ' ').toUpperCase()}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">Status</dt>
                <dd className="mt-1 text-sm font-semibold text-gray-900">{issue.status}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">Detected At</dt>
                <dd className="mt-1 text-sm text-gray-900">{formatDateTime(issue.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">Issue ID</dt>
                <dd className="mt-1 font-mono text-xs text-gray-600">{issue.id}</dd>
              </div>
            </dl>
          </div>

          {/* References */}
          <div>
            <h3 className="font-semibold text-gray-900">Transaction References</h3>
            <dl className="mt-3 space-y-3">
              {issue.txRef ? (
                <div className="flex items-start justify-between rounded-md border border-gray-200 p-3">
                  <div>
                    <dt className="text-xs text-gray-600">Merchant Reference (txRef)</dt>
                    <dd className="mt-1 font-mono text-sm font-semibold text-gray-900">
                      {issue.txRef}
                    </dd>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(issue.txRef!)}
                    className="text-xs text-brand-600 hover:text-brand-700"
                  >
                    Copy
                  </button>
                </div>
              ) : null}
              {issue.gatewayReference ? (
                <div className="flex items-start justify-between rounded-md border border-gray-200 p-3">
                  <div>
                    <dt className="text-xs text-gray-600">Gateway Reference (Chapa)</dt>
                    <dd className="mt-1 font-mono text-sm font-semibold text-gray-900">
                      {issue.gatewayReference}
                    </dd>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(issue.gatewayReference!)}
                    className="text-xs text-brand-600 hover:text-brand-700"
                  >
                    Copy
                  </button>
                </div>
              ) : null}
              {!issue.txRef && !issue.gatewayReference ? (
                <p className="text-sm text-gray-500">No transaction references available</p>
              ) : null}
            </dl>
          </div>

          {/* Action Items */}
          <div>
            <h3 className="font-semibold text-gray-900">Recommended Actions</h3>
            <ol className="mt-3 space-y-2">
              {getActionItems().map((action, index) => (
                <li key={index} className="flex gap-3 text-sm text-gray-700">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                    {index + 1}
                  </span>
                  <span>{action}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Technical Details */}
          {details && Object.keys(details).length > 0 ? (
            <div>
              <h3 className="font-semibold text-gray-900">Technical Details</h3>
              <div className="mt-3 rounded-md bg-gray-900 p-4">
                <pre className="overflow-x-auto text-xs text-gray-100">
                  {JSON.stringify(details, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}

          {/* Quick Links */}
          <div className="rounded-lg border-l-4 border-blue-500 bg-blue-50 p-4">
            <h3 className="font-semibold text-blue-900">Quick Links</h3>
            <ul className="mt-2 space-y-2 text-sm text-blue-800">
              <li>
                • <a href="https://dashboard.chapa.co" target="_blank" rel="noopener noreferrer" className="underline">
                  Chapa Dashboard
                </a> - Verify transaction status
              </li>
              <li>
                • <a href="/docs/reconciliation-guide" target="_blank" className="underline">
                  Reconciliation Guide
                </a> - Step-by-step resolution instructions
              </li>
              {issue.schoolId ? (
                <li>
                  • <a href={`/dashboard/schools/${issue.schoolId}/payments`} className="underline">
                    School Payments
                  </a> - Review related transactions
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
