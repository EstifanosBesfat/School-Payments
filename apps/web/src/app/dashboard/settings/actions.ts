'use server';

import { revalidatePath } from 'next/cache';
import { API_KEY_SCOPES, OUTBOUND_WEBHOOK_EVENTS } from '@payment/shared';
import { errorMessage, staffApi } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export interface SecretState extends FormState {
  secret?: string;
}

export async function updateSchoolAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi('/school', {
      method: 'PATCH',
      body: {
        city: String(formData.get('city') ?? '').trim() || undefined,
        contactEmail: String(formData.get('contactEmail') ?? '').trim() || undefined,
        contactPhone: String(formData.get('contactPhone') ?? '').trim() || undefined,
        smsSenderName: String(formData.get('smsSenderName') ?? '').trim() || undefined,
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/settings');
  return { success: 'School details saved.' };
}

export async function configureSettlementAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi('/school/settlement', {
      method: 'PUT',
      body: {
        bankCode: Number(formData.get('bankCode')),
        accountNumber: String(formData.get('accountNumber') ?? '').trim(),
        accountName: String(formData.get('accountName') ?? '').trim(),
        businessName: String(formData.get('businessName') ?? '').trim(),
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/settings');
  return { success: 'Payout account registered with the gateway.' };
}

export async function createStaffAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi('/school/users', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? '').trim(),
        email: String(formData.get('email') ?? '').trim(),
        password: String(formData.get('password') ?? ''),
        role: String(formData.get('role') ?? 'ACCOUNTANT'),
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/settings');
  return { success: 'Staff member created. They must enroll in two-factor authentication on first sign-in.' };
}

export async function setStaffActiveAction(id: string, isActive: boolean): Promise<void> {
  await staffApi(`/school/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { isActive } });
  revalidatePath('/dashboard/settings');
}

export async function createApiKeyAction(_previous: SecretState, formData: FormData): Promise<SecretState> {
  const scopes = formData.getAll('scope').map(String).filter((scope): scope is (typeof API_KEY_SCOPES)[number] => (API_KEY_SCOPES as readonly string[]).includes(scope));
  try {
    const created = await staffApi<{ key: string; prefix: string }>('/integrations/api-keys', {
      method: 'POST',
      body: { name: String(formData.get('name') ?? '').trim(), scopes },
    });
    revalidatePath('/dashboard/settings');
    return { success: `Key ${created.prefix}… created. Copy it now — it will not be shown again.`, secret: created.key };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function revokeApiKeyAction(id: string): Promise<void> {
  await staffApi(`/integrations/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  revalidatePath('/dashboard/settings');
}

export async function createWebhookAction(_previous: SecretState, formData: FormData): Promise<SecretState> {
  const events = formData
    .getAll('event')
    .map(String)
    .filter((event): event is (typeof OUTBOUND_WEBHOOK_EVENTS)[number] => (OUTBOUND_WEBHOOK_EVENTS as readonly string[]).includes(event));
  try {
    const created = await staffApi<{ secret: string; url: string }>('/integrations/webhooks', {
      method: 'POST',
      body: { url: String(formData.get('url') ?? '').trim(), events },
    });
    revalidatePath('/dashboard/settings');
    return { success: 'Webhook endpoint created. Copy the signing secret now.', secret: created.secret };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function setWebhookActiveAction(id: string, isActive: boolean): Promise<void> {
  await staffApi(`/integrations/webhooks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { isActive } });
  revalidatePath('/dashboard/settings');
}

export async function pingWebhookAction(id: string): Promise<void> {
  await staffApi(`/integrations/webhooks/${encodeURIComponent(id)}/ping`, { method: 'POST' });
}
