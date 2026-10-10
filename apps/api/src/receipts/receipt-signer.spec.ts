import { decodeReceiptQr, encodeReceiptQr, type ReceiptPayload, verifyReceiptSignature } from '@payment/shared';
import { generateKeyPairSync } from 'node:crypto';
import { ReceiptSigner } from './receipt-signer';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPemBase64: Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()).toString('base64'),
    publicKey: publicKey.export({ format: 'jwk' }).x as string,
  };
}

const payload: ReceiptPayload = {
  v: 1,
  kid: 'test-key',
  receiptNo: 'DEMO-R-2026-000001',
  school: { id: 'school_1', name: 'Addis Demo Academy', code: 'DEMO' },
  student: { name: 'Abebe Kebede', code: 'DEMO-001', grade: '5' },
  payer: { name: 'Kebede Alemu', phone: '+2519****5678' },
  invoiceNo: 'DEMO-2026-000001',
  items: [
    { label: 'Tuition', amount: 450000 },
    { label: 'Transport', amount: 120000 },
  ],
  total: 570000,
  currency: 'ETB',
  method: 'telebirr',
  gateway: 'chapa',
  gatewayRef: 'APfQ1x2y3z',
  txRef: 'DEMO-ABCDEFGHJKMNPQ',
  paidAt: '2026-10-09T10:00:00.000Z',
  issuedAt: '2026-10-09T10:00:05.000Z',
  prevHash: null,
};

describe('ReceiptSigner', () => {
  it('produces signatures the browser/offline verifier accepts', async () => {
    const keys = keyPair();
    const signer = new ReceiptSigner({ keyId: 'test-key', ...keys });
    const signed = await signer.sign(payload);
    const result = await verifyReceiptSignature(signer.publicKeys(), { payload, signature: signed.signature });
    expect(result).toEqual({ valid: true, payloadHash: signed.payloadHash, verificationCode: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}$/) });
  });

  it('detects any change to the receipt contents', async () => {
    const signer = new ReceiptSigner({ keyId: 'test-key', ...keyPair() });
    const signed = await signer.sign(payload);
    const tampered = { ...payload, total: 5700000 };
    const result = await verifyReceiptSignature(signer.publicKeys(), { payload: tampered, signature: signed.signature });
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('round-trips through the QR encoding', async () => {
    const signer = new ReceiptSigner({ keyId: 'test-key', ...keyPair() });
    const signed = await signer.sign(payload);
    const qr = encodeReceiptQr('https://pay.example.et/verify', { payload, signature: signed.signature });
    const decoded = decodeReceiptQr(qr);
    expect((await verifyReceiptSignature(signer.publicKeys(), decoded)).valid).toBe(true);
  });

  it('keeps verifying receipts signed with a retired key after rotation', async () => {
    const oldKeys = keyPair();
    const oldSigner = new ReceiptSigner({ keyId: 'test-key', ...oldKeys });
    const signed = await oldSigner.sign(payload);
    const newSigner = new ReceiptSigner({
      keyId: 'new-key',
      ...keyPair(),
      additionalPublicKeys: JSON.stringify({ 'test-key': oldKeys.publicKey }),
    });
    expect((await verifyReceiptSignature(newSigner.publicKeys(), { payload, signature: signed.signature })).valid).toBe(true);
  });

  it('refuses a public key that does not belong to the private key', () => {
    const a = keyPair();
    const b = keyPair();
    expect(() => new ReceiptSigner({ keyId: 'k', privateKeyPemBase64: a.privateKeyPemBase64, publicKey: b.publicKey })).toThrow(/does not match/);
  });
});
