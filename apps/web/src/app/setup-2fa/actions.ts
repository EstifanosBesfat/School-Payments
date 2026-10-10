'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { type TokenPair, writeSessionCookies } from '@/lib/session';

export interface TotpSetupState {
  error?: string;
  qrCodeDataUrl?: string;
  secret?: string;
}

export async function beginSetupAction(): Promise<TotpSetupState> {
  try {
    return await api<{ qrCodeDataUrl: string; secret: string }>('/auth/2fa/setup', { method: 'POST' });
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function enableTotpAction(previous: TotpSetupState, formData: FormData): Promise<TotpSetupState> {
  let tokens: TokenPair;
  try {
    tokens = await api<TokenPair>('/auth/2fa/enable', { method: 'POST', body: { code: String(formData.get('code') ?? '').trim() } });
  } catch (error) {
    return { ...previous, error: errorMessage(error) };
  }
  writeSessionCookies(await cookies(), tokens);
  redirect('/dashboard');
}
