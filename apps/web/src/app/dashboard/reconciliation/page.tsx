import type { Metadata } from 'next';
import { AlertCircle, CheckCircle2, Clock, Download, ExternalLink } from 'lucide-react';
import { Pagination } from '@/components/pagination';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/form';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Me, type Paginated, staffApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { IssueDetailsDialog } from './issue-details-dialog';
import { RunButton } from './run-button';
import { ResolveForm } from './resolve-form';

export const metadata: Metadata = { title: 'Reconciliation' };

interface RunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  checkedCount: number;
  issueCount: number;
  error: string | null;
}

interface IssueRow {
  id: string;
  kind: string;
  status: string;
  txRef: string | null;
  gatewayReference: string | null;
  createdAt: string;
  details: unknown;
  schoolId: string | null;
}

const ISSUE_KIND_DESCRIPTIONS: Record<string, { label: string; description: string; severity: 'critical' | 'warning' | 'info' }> = {
  status_mismatch: {
    label: 'Status Mismatch',
    description: 'Chapa shows success but database shows failed/pending',
    severity: 'critical',
  },
  gateway_tx_unknown: {
    label: 'Unknown at Gateway',
    description: 'Transaction exists at Chapa but not in database (likely retry loop)',
    severity: 'critical',
  },
  amount_mismatch: {
    label: 'Amount Mismatch',
    description: 'Payment amount differs between Chapa and database',
    severity: 'critical',
  },
  missing_at_gateway: {
    label: 'Missing at Gateway',
    description: 'Database shows success but Chapa doesn\'t have it',
    severity: 'warning',
  },
  gateway_unreachable: {
    label: 'Gateway Unreachable',
    description: 'Could not connect to Chapa API during reconciliation',
    severity: 'warning',
  },
  gateway_tx_without_reference: {
    label: 'No Reference',
    description: 'Chapa transaction missing merchant reference',
    severity: 'info',
  },
  receipt_chain_broken: {
    label: 'Receipt Chain Broken',
    description: 'Receipt blockchain integrity issue',
    severity: 'warning',
  },
};

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; kind?: string }>;
}) {
  const me = await staffApi<Me>('/auth/me');
  const query = await searchParams;
  const page = Number(query.page ?? '1') || 1;
  const issues = await staffApi<Paginated<IssueRow>>('/reconciliation/issues', {
    query: { page, pageSize: 25, status: query.status ?? 'OPEN', kind: query.kind },
  });
  const runs = me.role === 'PLATFORM_ADMIN' ? await staffApi<RunRow[]>('/reconciliation/runs') : [];

  // Get unique issue kinds for filter dropdown
  const issueKinds = Object.keys(ISSUE_KIND_DESCRIPTIONS);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
          <p className="mt-1 text-sm text-gray-600">
            Payment sync monitoring and multi-attempt checkout failure detection
          </p>
        </div>
        {me.role === 'PLATFORM_ADMIN' ? <RunButton /> : null}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-red-100 p-3">
              <AlertCircle className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Open Issues</p>
              <p className="text-2xl font-bold">{issues.total}</p>
            </div>
          </div>
        </Card>
        
        {runs.length > 0 ? (
          <>
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-blue-100 p-3">
                  <Clock className="h-6 w-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-600">Last Run</p>
                  <p className="text-lg font-semibold">
                    {formatDateTime(runs[0].startedAt).split(',')[0]}
                  </p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-green-100 p-3">
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-600">Last Checked</p>
                  <p className="text-2xl font-bold">{runs[0].checkedCount}</p>
                </div>
              </div>
            </Card>
          </>
        ) : null}
      </div>

      {runs.length > 0 && me.role === 'PLATFORM_ADMIN' ? (
        <Card>
          <CardHeader title="Recent Runs" />
          <Table>
            <thead>
              <tr>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Checked</Th>
                <Th>Issues Found</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const duration = run.finishedAt
                  ? Math.round(
                      (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) /
                        1000,
                    )
                  : null;
                return (
                  <tr key={run.id}>
                    <Td>{formatDateTime(run.startedAt)}</Td>
                    <Td>{duration ? `${duration}s` : 'Running...'}</Td>
                    <Td>{run.checkedCount}</Td>
                    <Td>
                      <span
                        className={
                          run.issueCount > 0 ? 'font-semibold text-red-600' : 'text-gray-600'
                        }
                      >
                        {run.issueCount}
                      </span>
                    </Td>
                    <Td>
                      {run.error ? (
                        <span className="text-xs text-red-600" title={run.error}>
                          Failed
                        </span>
                      ) : (
                        <span className="text-xs text-green-600">Success</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Issues">
          <p className="mt-1 text-sm text-gray-600">
            Review payment discrepancies between Chapa and your database
          </p>
        </CardHeader>
        
        <form className="flex flex-wrap gap-3 border-t border-gray-200 px-5 py-4" method="get">
          <Field label="Status" htmlFor="status" className="w-36">
            <Select id="status" name="status" defaultValue={query.status ?? 'OPEN'}>
              <option value="">All</option>
              <option value="OPEN">Open</option>
              <option value="RESOLVED">Resolved</option>
            </Select>
          </Field>
          
          <Field label="Issue Type" htmlFor="kind" className="w-52">
            <Select id="kind" name="kind" defaultValue={query.kind ?? ''}>
              <option value="">All Types</option>
              {issueKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {ISSUE_KIND_DESCRIPTIONS[kind]?.label || kind}
                </option>
              ))}
            </Select>
          </Field>
          
          <button
            type="submit"
            className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Apply Filters
          </button>

          {issues.total > 0 ? (
            <a
              href={`/api/reconciliation/issues/export?status=${query.status || ''}&kind=${query.kind || ''}`}
              className="mt-6 inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          ) : null}
        </form>

        <Table>
          <thead>
            <tr>
              <Th>Severity</Th>
              <Th>Issue Type</Th>
              <Th>Reference</Th>
              <Th>Detected</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {issues.items.length === 0 ? (
              <EmptyRow colSpan={5}>
                {query.status === 'OPEN'
                  ? '🎉 No open issues. All payments are in sync with Chapa.'
                  : 'No issues found with current filters.'}
              </EmptyRow>
            ) : null}
            {issues.items.map((issue) => {
              const kindInfo = ISSUE_KIND_DESCRIPTIONS[issue.kind];
              const severityColors = {
                critical: 'bg-red-100 text-red-800',
                warning: 'bg-yellow-100 text-yellow-800',
                info: 'bg-blue-100 text-blue-800',
              };
              
              return (
                <tr key={issue.id} className="hover:bg-gray-50">
                  <Td>
                    {kindInfo ? (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${severityColors[kindInfo.severity]}`}
                      >
                        {kindInfo.severity}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <div className="flex items-start gap-2">
                      <StatusBadge status={issue.status} />
                      <div>
                        <p className="font-medium text-gray-900">
                          {kindInfo?.label || issue.kind.replace(/_/g, ' ')}
                        </p>
                        <p className="text-xs text-gray-600">{kindInfo?.description}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <div className="space-y-1">
                      {issue.txRef ? (
                        <p className="font-mono text-xs text-gray-900" title="Merchant Reference">
                          {issue.txRef}
                        </p>
                      ) : null}
                      {issue.gatewayReference ? (
                        <p className="font-mono text-xs text-gray-500" title="Gateway Reference">
                          {issue.gatewayReference}
                        </p>
                      ) : null}
                      {!issue.txRef && !issue.gatewayReference ? '—' : null}
                    </div>
                  </Td>
                  <Td>
                    <p className="whitespace-nowrap text-sm">{formatDateTime(issue.createdAt)}</p>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <IssueDetailsDialog issue={issue} />
                      {issue.status === 'OPEN' ? (
                        <ResolveForm issueId={issue.id} txRef={issue.txRef} kind={issue.kind} />
                      ) : (
                        <span className="text-xs text-green-600">✓ Resolved</span>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Pagination
          path="/dashboard/reconciliation"
          page={issues.page}
          pageSize={issues.pageSize}
          total={issues.total}
          query={{ status: query.status, kind: query.kind }}
        />
      </Card>

      {/* Help Section */}
      <Card className="border-l-4 border-blue-500 bg-blue-50">
        <div className="p-4">
          <h3 className="flex items-center gap-2 font-semibold text-blue-900">
            <AlertCircle className="h-5 w-5" />
            About Multi-Attempt Checkout Failures
          </h3>
          <p className="mt-2 text-sm text-blue-800">
            When parents retry payments inside Chapa's checkout page, the transaction may succeed
            at Chapa but your database shows it as failed or pending. The sweep worker (runs every 5
            minutes) automatically detects and fixes these issues. Critical issues require manual
            review using the "View Details" and "Resolve" buttons above.
          </p>
          <a
            href="/docs/reconciliation-guide"
            target="_blank"
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            View Reconciliation Guide
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </Card>
    </div>
  );
}
