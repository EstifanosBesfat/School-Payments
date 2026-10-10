import { cookies } from 'next/headers';
import { proxyDownload } from '@/lib/proxy-response';
import { ACCESS_COOKIE } from '@/lib/session';

export async function GET(request: Request) {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return new Response('Sign in required', { status: 401 });
  const { searchParams } = new URL(request.url);
  return proxyDownload('/receipts/export.csv', {
    token,
    query: { from: searchParams.get('from') ?? undefined, to: searchParams.get('to') ?? undefined },
  });
}
