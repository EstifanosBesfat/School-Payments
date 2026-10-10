'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError, errorMessage } from '@/lib/api';
import { clearSessionCookies, REFRESH_COOKIE, type TokenPair, writeSessionCookies } from '@/lib/session';

export interface LoginState {
  error?: string;
  needTotp?: boolean;
  email?: string;
}

function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === 'string' ? value : '';
  return next.startsWith('/dashboard') ? next : '/dashboard';
}

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totpCode') ?? '').trim();
  let tokens: TokenPair;
  try {
    tokens = await api<TokenPair>('/auth/login', {
      method: 'POST',
      auth: 'none',
      body: { email, password, ...(totpCode ? { totpCode } : {}) },
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'TOTP_REQUIRED') return { needTotp: true, email };
    if (error instanceof ApiError && error.code === 'TOTP_INVALID') return { needTotp: true, email, error: error.message };
    return { error: errorMessage(error), email, needTotp: Boolean(totpCode) };
  }
  writeSessionCookies(await cookies(), tokens);
  redirect(tokens.mfa === 'setup_required' ? '/setup-2fa' : safeNext(formData.get('next')));
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    await api('/auth/logout', { method: 'POST', auth: 'none', body: { refreshToken } }).catch(() => undefined);
  }
  clearSessionCookies(store);
  redirect('/login');
}
