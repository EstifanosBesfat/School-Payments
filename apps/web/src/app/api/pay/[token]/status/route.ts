import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tx = new URL(request.url).searchParams.get('tx');
  if (!tx) return NextResponse.json({ message: 'Missing tx' }, { status: 400 });
  try {
    const status = await api(`/pay/${encodeURIComponent(token)}/status`, { auth: 'none', query: { tx } });
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502;
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Error' }, { status });
  }
}
