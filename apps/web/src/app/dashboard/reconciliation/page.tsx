import type { Metadata } from 'next';
import { Pagination } from '@/components/pagination';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/form';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Me, type Paginated, staffApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
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
  createdAt: string;
  details: unknown;
}

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const me = await staffApi<Me>('/auth/me');
  const query = await searchParams;
  const page = Number(query.page ?? '1') || 1;
  const issues = await staffApi<Paginated<IssueRow>>('/reconciliation/issues', {
    query: { page, pageSize: 25, status: query.status ?? 'OPEN' },
  });
  const runs = me.role === 'PLATFORM_ADMIN' ? await staffApi<RunRow[]>('/reconciliation/runs') : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
        {me.role === 'PLATFORM_ADMIN' ? <RunButton /> : null}
      </div>
      {runs.length > 0 ? (
        <Card>
          <CardHeader title="Recent runs" />
          <Table>
            <thead>
              <tr>
                <Th>Started</Th>
                <Th>Checked</Th>
                <Th>Issues</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <Td>{formatDateTime(run.startedAt)}</Td>
                  <Td>{run.checkedCount}</Td>
                  <Td>
                    {run.issueCount}
                    {run.error ? <span className="block text-xs text-red-600">{run.error}</span> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Issues" />
        <form className="flex gap-3 px-5 py-3" method="get">
          <Field label="Status" htmlFor="status" className="w-40">
            <Select id="status" name="status" defaultValue={query.status ?? 'OPEN'}>
              <option value="OPEN">Open</option>
              <option value="RESOLVED">Resolved</option>
            </Select>
          </Field>
          <button type="submit" className="mt-6 text-sm font-semibold text-brand-700">
            Filter
          </button>
        </form>
        <Table>
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>Reference</Th>
              <Th>When</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {issues.items.length === 0 ? <EmptyRow colSpan={4}>Nothing to review.</EmptyRow> : null}
            {issues.items.map((issue) => (
              <tr key={issue.id}>
                <Td>
                  <StatusBadge status={issue.status} />
                  <span className="ml-2 text-sm">{issue.kind.replace(/_/g, ' ')}</span>
                </Td>
                <Td className="font-mono text-xs">{issue.txRef ?? '—'}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(issue.createdAt)}</Td>
                <Td>{issue.status === 'OPEN' ? <ResolveForm issueId={issue.id} /> : null}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Pagination path="/dashboard/reconciliation" page={issues.page} pageSize={issues.pageSize} total={issues.total} query={{ status: query.status }} />
      </Card>
    </div>
  );
}
