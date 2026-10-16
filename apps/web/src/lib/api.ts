import { cookies, headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { serverApiUrl } from './server-api-url';
import { ACCESS_COOKIE, PARENT_COOKIE } from './session';

export const API_URL = serverApiUrl();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type AuthMode = 'staff' | 'parent' | 'none';

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: AuthMode;
  idempotencyKey?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function messageFrom(body: unknown, status: number): { message: string; code?: string } {
  if (body && typeof body === 'object') {
    const record = body as {
      message?: unknown;
      code?: unknown;
      issues?: { path?: string; message?: string }[];
    };
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (Array.isArray(record.issues) && record.issues.length > 0) {
      return {
        message: record.issues
          .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
          .join('; '),
        code,
      };
    }
    if (typeof record.message === 'string') return { message: record.message, code };
    if (Array.isArray(record.message)) return { message: record.message.join('; '), code };
  }
  return {
    message:
      status >= 500 ? 'The server had a problem. Please try again.' : `Request failed (${status})`,
  };
}

export async function clientIpHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const result: Record<string, string> = {};
  const agent = incoming.get('user-agent');
  if (agent) result['User-Agent'] = agent;
  return result;
}

export function buildUrl(path: string, query?: ApiRequestOptions['query']): string {
  const url = new URL(path, serverApiUrl());
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Server-side call to the API. Staff and parent tokens live in httpOnly cookies and never reach the browser JS. */
export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const store = await cookies();
  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...(await clientIpHeaders()),
  };
  const auth = options.auth ?? 'staff';
  const token =
    auth === 'staff'
      ? store.get(ACCESS_COOKIE)?.value
      : auth === 'parent'
        ? store.get(PARENT_COOKIE)?.value
        : undefined;
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (options.idempotencyKey) requestHeaders['Idempotency-Key'] = options.idempotencyKey;

  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: requestHeaders,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { message, code } = messageFrom(body, response.status);
    throw new ApiError(response.status, message, code, body);
  }
  return body as T;
}

/** For server components: send the user to sign in (or 2FA setup) instead of rendering an error. */
export async function staffApi<T>(
  path: string,
  options: Omit<ApiRequestOptions, 'auth'> = {},
): Promise<T> {
  try {
    return await api<T>(path, { ...options, auth: 'staff' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    if (error instanceof ApiError && error.code === 'MFA_SETUP_REQUIRED') redirect('/setup-2fa');
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  unstable_rethrow(error);
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: 'PLATFORM_ADMIN' | 'SCHOOL_ADMIN' | 'ACCOUNTANT';
  totpEnabled: boolean;
  mfa: string;
  school: { id: string; name: string; code: string; status: string; logoUrl: string | null } | null;
}
