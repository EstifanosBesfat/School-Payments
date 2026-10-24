import { inflateSync } from 'node:zlib';
import type { ReceiptPayload } from '@payment/shared';
import { renderReceiptPdf } from './receipt-pdf';

function decodePdfStrings(content: string): string {
  const blocks = content.match(/BT[\s\S]*?ET/g) ?? [];
  return blocks
    .map((block) => {
      let text = '';
      for (const match of block.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const hex = match[1] ?? '';
        for (let index = 0; index < hex.length; index += 2) text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
      }
      return text;
    })
    .join('\n');
}

function pdfText(pdf: Buffer): string {
  const marker = Buffer.from('stream\n');
  const end = Buffer.from('endstream');
  const parts: string[] = [];
  let offset = 0;
  while (offset < pdf.length) {
    const start = pdf.indexOf(marker, offset);
    if (start < 0) break;
    const dataStart = start + marker.length;
    const dataEnd = pdf.indexOf(end, dataStart);
    if (dataEnd < 0) break;
    const slice = pdf.subarray(dataStart, dataEnd);
    try {
      parts.push(inflateSync(slice).toString('latin1'));
    } catch {
      parts.push(slice.toString('latin1'));
    }
    offset = dataEnd + end.length;
  }
  return parts.join('\n');
}

const payload: ReceiptPayload = {
  v: 1,
  kid: 'test-key',
  receiptNo: 'DEMO-R-2026-000001',
  school: { id: 'school_1', name: 'Addis Demo Academy', code: 'DEMO' },
  student: { name: 'Abebe Kebede', code: 'DEMO-001', grade: '5' },
  payer: { name: 'Kebede Alemu', phone: '+2519****5678' },
  invoiceNo: 'DEMO-2026-000001',
  items: [{ label: 'Tuition', amount: 10_000 }],
  total: 10_000,
  currency: 'ETB',
  method: 'telebirr',
  gateway: 'arifpay',
  gatewayRef: 'BCI6FETYVI',
  txRef: 'DEMO-ABCDEFGHJKMNPQ',
  paidAt: '2026-10-09T10:00:00.000Z',
  issuedAt: '2026-10-09T10:00:05.000Z',
  prevHash: null,
};

describe('receipt pdf', () => {
  it('prints the rail and hides the provider name', async () => {
    const pdf = await renderReceiptPdf({
      payload,
      payloadHash: 'abc123',
      qrContent: 'https://pay.example/verify',
      verifyUrl: 'https://pay.example/verify',
    });
    const text = decodePdfStrings(pdfText(pdf));
    expect(text).toContain('Telebirr');
    expect(text.toLowerCase()).not.toContain('arifpay');
    expect(text.toLowerCase()).not.toContain('chapa');
    expect(text).not.toContain('via arifpay');
  }, 20_000);
});
