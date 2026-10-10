import { buildUrl, clientIpHeaders } from './api';

/** Streams a binary/text API response (PDF, CSV, HTML) through a route handler, keeping auth server-side. */
export async function proxyDownload(path: string, init: { token?: string; query?: Record<string, string | undefined> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(await clientIpHeaders()) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const upstream = await fetch(buildUrl(path, init.query), { headers, cache: 'no-store' });
  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => null)) as { message?: string } | null;
    return new Response(body?.message ?? 'Not found', { status: upstream.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const forwarded = new Headers();
  for (const name of ['content-type', 'content-disposition', 'cache-control']) {
    const value = upstream.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers: forwarded });
}
