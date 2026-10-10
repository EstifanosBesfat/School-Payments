import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const receiptNo = searchParams.get('receiptNo') ?? '';
  const code = searchParams.get('code') ?? '';
  try {
    const result = await api('/receipts/lookup', { auth: 'none', query: { receiptNo, code } });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502;
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Error' }, { status });
  }
}
