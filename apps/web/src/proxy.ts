import { type NextRequest, NextResponse } from 'next/server';
import { serverApiUrl } from './lib/server-api-url';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  secondsUntilExpiry,
  type TokenPair,
  writeSessionCookies,
} from './lib/session';
const REFRESH_BEFORE_SECONDS = 60;

function toLogin(request: NextRequest): NextResponse {
  const url = new URL('/login', request.url);
  url.searchParams.set('next', request.nextUrl.pathname);
  const response = NextResponse.redirect(url);
  response.cookies.delete(ACCESS_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  return response;
}

/**
 * Keeps staff sessions alive: when the short-lived access token is missing or about to expire,
 * rotate the refresh token before the page renders, so server components always see a valid token.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (secondsUntilExpiry(access) > REFRESH_BEFORE_SECONDS) return NextResponse.next();
  if (!refresh) return toLogin(request);

  const result = await fetch(`${serverApiUrl()}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': request.headers.get('user-agent') ?? 'web',
    },
    body: JSON.stringify({ refreshToken: refresh }),
    cache: 'no-store',
  }).catch(() => null);
  if (!result || !result.ok) return toLogin(request);

  const tokens = (await result.json()) as TokenPair;
  request.cookies.set(ACCESS_COOKIE, tokens.accessToken);
  request.cookies.set(REFRESH_COOKIE, tokens.refreshToken);
  const response = NextResponse.next({ request });
  writeSessionCookies(response.cookies, tokens);
  return response;
}

export const config = {
  matcher: ['/dashboard/:path*', '/setup-2fa', '/api/staff/:path*'],
};
