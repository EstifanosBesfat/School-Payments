import { cookies } from 'next/headers';
import { proxyDownload } from '@/lib/proxy-response';
import { ACCESS_COOKIE } from '@/lib/session';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return new Response('Sign in required', { status: 401 });
  return proxyDownload(`/receipts/${encodeURIComponent(id)}/pdf`, { token });
}
