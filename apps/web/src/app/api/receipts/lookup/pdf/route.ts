import { proxyDownload } from '@/lib/proxy-response';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  return proxyDownload('/receipts/lookup/pdf', {
    query: { receiptNo: searchParams.get('receiptNo') ?? undefined, code: searchParams.get('code') ?? undefined },
  });
}
