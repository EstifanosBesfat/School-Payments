import { proxyDownload } from '@/lib/proxy-response';

export async function GET() {
  return proxyDownload('/receipts/offline-verifier.html');
}
