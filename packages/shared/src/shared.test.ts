import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { bytesToBase64Url, canonicalJson, utf8Encode } from './encoding';
import { gregorianToEthiopian } from './ethiopian-calendar';
import { etbStringToSantim, formatEtb, santimToEtbString } from './money';
import { maskPhone, normalizeEthiopianPhone, toLocalPhone } from './phone';
import {
  canonicalReceiptPayload,
  decodeReceiptQr,
  encodeReceiptQr,
  type ReceiptPayload,
  verifyReceiptSignature,
} from './receipt';

test('money conversions are exact', () => {
  assert.equal(santimToEtbString(15050), '150.50');
  assert.equal(santimToEtbString(5), '0.05');
  assert.equal(etbStringToSantim('150.5'), 15050);
  assert.equal(etbStringToSantim('400.00'), 40000);
  assert.equal(formatEtb(150050), 'ETB 1,500.50');
  assert.throws(() => etbStringToSantim('1.234'));
  assert.throws(() => santimToEtbString(1.5));
});

test('Ethiopian phone numbers normalize to E.164', () => {
  assert.equal(normalizeEthiopianPhone('0912345678'), '+251912345678');
  assert.equal(normalizeEthiopianPhone('+251 712 345 678'), '+251712345678');
  assert.equal(normalizeEthiopianPhone('251912345678'), '+251912345678');
  assert.equal(toLocalPhone('+251912345678'), '0912345678');
  assert.equal(maskPhone('+251912345678'), '+2519****5678');
  assert.throws(() => normalizeEthiopianPhone('0112345678'));
});

test('Gregorian to Ethiopian calendar conversion', () => {
  assert.deepEqual(gregorianToEthiopian(2023, 9, 12), { year: 2016, month: 1, day: 1 });
  assert.deepEqual(gregorianToEthiopian(2023, 9, 11), { year: 2015, month: 13, day: 6 });
  assert.deepEqual(gregorianToEthiopian(2026, 9, 11), { year: 2019, month: 1, day: 1 });
  assert.deepEqual(gregorianToEthiopian(2025, 1, 7), { year: 2017, month: 4, day: 29 });
});

test('canonical JSON sorts keys deterministically', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
});

test('receipt signatures verify offline and detect tampering', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ format: 'jwk' }).x as string;
  const payload: ReceiptPayload = {
    v: 1,
    kid: 'k1',
    receiptNo: 'TST-2026-000001',
    school: { id: 's1', name: 'Test School', code: 'TST' },
    student: { name: 'Abebe Kebede', code: 'ST-1', grade: '5' },
    payer: { name: 'Kebede Alemu', phone: '+2519****5678' },
    invoiceNo: 'TST-INV-000001',
    items: [{ label: 'Tuition', amount: 150000 }],
    total: 150000,
    currency: 'ETB',
    method: 'telebirr',
    gateway: 'chapa',
    gatewayRef: 'AP123',
    txRef: 'tx_1',
    paidAt: '2026-10-09T10:00:00.000Z',
    issuedAt: '2026-10-09T10:00:05.000Z',
    prevHash: null,
  };
  const signature = bytesToBase64Url(
    new Uint8Array(sign(null, Buffer.from(utf8Encode(canonicalReceiptPayload(payload))), privateKey)),
  );
  const qr = encodeReceiptQr('https://pay.example/verify', { payload, signature });
  const decoded = decodeReceiptQr(qr);
  const result = await verifyReceiptSignature({ k1: rawPublic }, decoded);
  assert.equal(result.valid, true);

  const tampered = { ...decoded, payload: { ...decoded.payload, total: 1500 } };
  const tamperedResult = await verifyReceiptSignature({ k1: rawPublic }, tampered);
  assert.deepEqual(tamperedResult, { valid: false, reason: 'bad_signature' });
});
