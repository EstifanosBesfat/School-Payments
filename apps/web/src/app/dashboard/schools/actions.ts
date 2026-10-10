'use server';

import { revalidatePath } from 'next/cache';
import { errorMessage, staffApi } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export async function createSchoolAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi('/schools', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? '').trim(),
        code: String(formData.get('code') ?? '').trim().toUpperCase(),
        contactEmail: String(formData.get('contactEmail') ?? '').trim(),
        contactPhone: String(formData.get('contactPhone') ?? '').trim(),
        city: String(formData.get('city') ?? '').trim() || undefined,
        admin: {
          name: String(formData.get('adminName') ?? '').trim(),
          email: String(formData.get('adminEmail') ?? '').trim(),
          password: String(formData.get('adminPassword') ?? ''),
        },
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/schools');
  revalidatePath('/dashboard');
  return { success: 'School created. The admin must set up two-factor authentication on first sign-in.' };
}

export async function setSchoolStatusAction(id: string, _previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi(`/schools/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: { status: String(formData.get('status') ?? '') },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/schools');
  return { success: 'Status updated.' };
}
