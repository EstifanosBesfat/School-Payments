import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { type Me, staffApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { pingWebhookAction, revokeApiKeyAction, setStaffActiveAction, setWebhookActiveAction } from './actions';
import { ApiKeyForm, SchoolForm, SettlementForm, StaffForm, WebhookForm } from './forms';

export const metadata: Metadata = { title: 'Settings' };

interface School {
  name: string;
  code: string;
  status: string;
  city: string | null;
  contactEmail: string;
  contactPhone: string;
  smsSenderName: string | null;
  settlementSummary: string | null;
  chapaSubaccountId: string | null;
}

interface StaffRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
}

export default async function SettingsPage() {
  const me = await staffApi<Me>('/auth/me');
  if (me.role !== 'SCHOOL_ADMIN') redirect('/dashboard');

  const [school, banks, staff, apiKeys, webhooks] = await Promise.all([
    staffApi<School>('/school'),
    staffApi<{ id: number; name: string }[]>('/school/banks'),
    staffApi<StaffRow[]>('/school/users'),
    staffApi<ApiKeyRow[]>('/integrations/api-keys'),
    staffApi<WebhookRow[]>('/integrations/webhooks'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-gray-500">
          {school.name} · {school.code} · {school.status.toLowerCase()}
        </p>
      </div>
      <Card>
        <CardHeader title="School" />
        <CardBody>
          <SchoolForm school={school} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Payout account"
          description={
            school.settlementSummary
              ? `Currently ${school.settlementSummary}. Money never sits on this platform — it settles to this account via the gateway split.`
              : 'Register a bank account so the gateway can split each payment to the school.'
          }
        />
        <CardBody>
          <SettlementForm banks={banks} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Staff" />
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>2FA</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {staff.map((user) => (
              <tr key={user.id}>
                <Td>
                  <p className="font-medium">{user.name}</p>
                  <p className="text-xs text-gray-500">{user.email}</p>
                </Td>
                <Td>{user.role.replace('_', ' ').toLowerCase()}</Td>
                <Td>{user.totpEnabled ? 'On' : 'Required'}</Td>
                <Td>
                  {user.id !== me.id ? (
                    <form action={setStaffActiveAction.bind(null, user.id, !user.isActive)}>
                      <Button type="submit" variant="ghost" size="sm">
                        {user.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                    </form>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <CardBody>
          <StaffForm />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="API keys" description="Shown once. Scoped to this school. Use the public REST API at /v1." />
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Prefix</Th>
              <Th>Scopes</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {apiKeys.length === 0 ? <EmptyRow colSpan={4}>No API keys.</EmptyRow> : null}
            {apiKeys.map((key) => (
              <tr key={key.id}>
                <Td>{key.name}</Td>
                <Td className="font-mono text-xs">{key.prefix}…</Td>
                <Td className="text-xs">{key.scopes.join(', ')}</Td>
                <Td>
                  {key.revokedAt ? (
                    <span className="text-xs text-gray-500">Revoked {formatDateTime(key.revokedAt)}</span>
                  ) : (
                    <form action={revokeApiKeyAction.bind(null, key.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Revoke
                      </Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <CardBody>
          <ApiKeyForm />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Webhooks" description="Signed with HMAC. Deliveries retry automatically." />
        <Table>
          <thead>
            <tr>
              <Th>URL</Th>
              <Th>Events</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {webhooks.length === 0 ? <EmptyRow colSpan={3}>No endpoints.</EmptyRow> : null}
            {webhooks.map((hook) => (
              <tr key={hook.id}>
                <Td className="break-all text-xs">{hook.url}</Td>
                <Td className="text-xs">{hook.events.join(', ')}</Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    <form action={setWebhookActiveAction.bind(null, hook.id, !hook.isActive)}>
                      <Button type="submit" variant="ghost" size="sm">
                        {hook.isActive ? 'Disable' : 'Enable'}
                      </Button>
                    </form>
                    <form action={pingWebhookAction.bind(null, hook.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Ping
                      </Button>
                    </form>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <CardBody>
          <WebhookForm />
        </CardBody>
      </Card>
    </div>
  );
}
