import { proxyDownload } from '@/lib/proxy-response';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; receiptId: string }> }) {
  const { token, receiptId } = await params;
  return proxyDownload(`/pay/${encodeURIComponent(token)}/receipts/${encodeURIComponent(receiptId)}/pdf`);
}
