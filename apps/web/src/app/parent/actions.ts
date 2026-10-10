'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { clearParentCookie, writeParentCookie } from '@/lib/session';
import type { FormState } from '@/lib/utils';

export interface ParentOtpState extends FormState {
  phone?: string;
  sent?: boolean;
}

export async function requestOtpAction(_previous: ParentOtpState, formData: FormData): Promise<ParentOtpState> {
  const phone = String(formData.get('phone') ?? '').trim();
  try {
    await api('/parent/otp/request', { method: 'POST', auth: 'none', body: { phone } });
  } catch (error) {
    return { error: errorMessage(error), phone };
  }
  return { sent: true, phone, success: 'If this number is registered, a 6-digit code was sent by SMS.' };
}

export async function verifyOtpAction(_previous: ParentOtpState, formData: FormData): Promise<ParentOtpState> {
  const phone = String(formData.get('phone') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim();
  try {
    const tokens = await api<{ accessToken: string; expiresAt: string }>('/parent/otp/verify', {
      method: 'POST',
      auth: 'none',
      body: { phone, code },
    });
    writeParentCookie(await cookies(), tokens.accessToken, tokens.expiresAt);
  } catch (error) {
    return { error: errorMessage(error), phone, sent: true };
  }
  redirect('/parent');
}

export async function parentLogoutAction(): Promise<void> {
  clearParentCookie(await cookies());
  redirect('/parent');
}
