import { formatEatDateTime, formatEtb, formatEthiopianDate, type ReceiptPayload, shortVerificationCode } from '@payment/shared';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { payerMethodLabel } from './payer-method-label';

export interface ReceiptPdfInput {
  payload: ReceiptPayload;
  payloadHash: string;
  qrContent: string;
  verifyUrl: string;
}

const INK = '#111827';
const MUTED = '#6b7280';
const ACCENT = '#047857';
const RULE = '#e5e7eb';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** A4 receipt with a QR code that carries the full signed payload for offline verification. */
export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  const { payload } = input;
  const qr = await QRCode.toBuffer(input.qrContent, { errorCorrectionLevel: 'M', margin: 1, width: 600 });
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: `Receipt ${payload.receiptNo}`, Author: payload.school.name, Subject: 'Payment receipt', Keywords: payload.txRef },
  });
  const done = collect(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const paidAt = new Date(payload.paidAt);

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(payload.school.name, left, 48, { width: width - 140 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`School code ${payload.school.code}`, { width: width - 140 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text('OFFICIAL PAYMENT RECEIPT', left + width - 200, 52, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Digitally signed (Ed25519)', left + width - 200, 68, { width: 200, align: 'right' });

  doc.moveTo(left, 104).lineTo(left + width, 104).strokeColor(RULE).lineWidth(1).stroke();

  const field = (label: string, value: string, x: number, y: number, w: number) => {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: w });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(value, x, y + 11, { width: w });
  };
  const col = width / 2;
  field('Receipt number', payload.receiptNo, left, 118, col);
  field('Date paid', `${formatEatDateTime(paidAt)} EAT`, left + col, 118, col);
  field('Student', `${payload.student.name} (${payload.student.code})`, left, 152, col);
  field('Ethiopian calendar', formatEthiopianDate(paidAt, 'en'), left + col, 152, col);
  field('Grade', payload.student.grade, left, 186, col);
  field('Invoice', payload.invoiceNo, left + col, 186, col);
  field('Paid by', `${payload.payer.name}  ${payload.payer.phone}`, left, 220, col);
  field('Payment method', payerMethodLabel(payload.method) || 'Mobile money', left + col, 220, col);

  let y = 266;
  doc.rect(left, y, width, 22).fill('#f3f4f6');
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5).text('DESCRIPTION', left + 10, y + 7).text('AMOUNT', left + width - 160, y + 7, { width: 150, align: 'right' });
  y += 22;
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  for (const item of payload.items) {
    doc.text(item.label, left + 10, y + 7, { width: width - 190 });
    doc.text(formatEtb(item.amount), left + width - 160, y + 7, { width: 150, align: 'right' });
    y += 24;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(RULE).stroke();
  }
  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('TOTAL PAID', left + 10, y + 4);
  doc.fillColor(ACCENT).text(formatEtb(payload.total), left + width - 200, y + 4, { width: 190, align: 'right' });
  y += 36;

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  doc.text(`Payment reference: ${payload.gatewayRef}`, left, y);
  doc.text(`Transaction reference: ${payload.txRef}`, left, y + 12);
  doc.text(`Issued: ${formatEatDateTime(new Date(payload.issuedAt))} EAT`, left, y + 24);
  y += 52;

  const qrSize = 170;
  doc.rect(left, y, width, qrSize + 24).strokeColor(RULE).stroke();
  doc.image(qr, left + 12, y + 12, { width: qrSize, height: qrSize });
  const tx = left + qrSize + 32;
  const tw = width - qrSize - 44;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('VERIFICATION CODE', tx, y + 16, { width: tw });
  doc.font('Courier-Bold').fontSize(24).fillColor(INK).text(shortVerificationCode(input.payloadHash), tx, y + 28, { width: tw });
  doc.font('Helvetica').fontSize(9).fillColor(INK).text(
    'Keep this receipt as proof of payment. Its contents are digitally signed by the school payment platform; any change invalidates it.',
    tx,
    y + 66,
    { width: tw },
  );
  doc.fillColor(MUTED).fontSize(8.5).text(
    `Verify: scan the QR code, or enter the receipt number and code at ${input.verifyUrl}. ` +
      'The QR code contains the signed receipt itself, so it can be checked even when the platform is offline.',
    tx,
    y + 108,
    { width: tw },
  );
  y += qrSize + 40;

  doc.font('Courier').fontSize(6.5).fillColor(MUTED);
  doc.text(`key ${payload.kid}  sha256 ${input.payloadHash}`, left, y, { width });
  doc.text(`prev ${payload.prevHash ?? 'none (first receipt)'}`, left, y + 9, { width });

  doc.end();
  return done;
}
