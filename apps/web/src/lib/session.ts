interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  expires?: Date;
  maxAge?: number;
}

export interface CookieWriter {
  set(name: string, value: string, options?: CookieOptions): unknown;
  delete(name: string): unknown;
}

export const ACCESS_COOKIE = 'pp_at';
export const REFRESH_COOKIE = 'pp_rt';
export const PARENT_COOKIE = 'pp_pt';

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  mfa: 'ok' | 'setup_required' | 'not_required';
  user: { id: string; name: string; email: string; role: string; schoolId: string | null };
}

const secure = process.env.NODE_ENV === 'production';

export function writeSessionCookies(cookies: CookieWriter, tokens: TokenPair): void {
  cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(tokens.accessTokenExpiresAt),
  });
  cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    expires: new Date(tokens.refreshTokenExpiresAt),
  });
}

export function clearSessionCookies(cookies: CookieWriter): void {
  cookies.delete(ACCESS_COOKIE);
  cookies.delete(REFRESH_COOKIE);
}

export function writeParentCookie(cookies: CookieWriter, accessToken: string, expiresAt: string): void {
  cookies.set(PARENT_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearParentCookie(cookies: CookieWriter): void {
  cookies.delete(PARENT_COOKIE);
}

/** Seconds until the JWT expires (no signature check: the API verifies every request). */
export function secondsUntilExpiry(token: string | undefined): number {
  if (!token) return -1;
  const [, payload] = token.split('.');
  if (!payload) return -1;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return json.exp ? json.exp - Math.floor(Date.now() / 1000) : -1;
  } catch {
    return -1;
  }
}
