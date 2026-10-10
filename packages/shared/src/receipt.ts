import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  canonicalJson,
  utf8Decode,
  utf8Encode,
} from './encoding';

export const RECEIPT_PAYLOAD_VERSION = 1;

export interface ReceiptLineItem {
  label: string;
  amount: number;
}

/**
 * Everything printed on a receipt that matters as proof of payment. The canonical JSON of
 * this object is what gets signed, hashed and embedded in the QR code.
 */
export interface ReceiptPayload {
  v: number;
  kid: string;
  receiptNo: string;
  school: { id: string; name: string; code: string };
  student: { name: string; code: string; grade: string };
  payer: { name: string; phone: string };
  invoiceNo: string;
  items: ReceiptLineItem[];
  total: number;
  currency: 'ETB';
  method: string;
  gateway: string;
  gatewayRef: string;
  txRef: string;
  paidAt: string;
  issuedAt: string;
  prevHash: string | null;
}

export function canonicalReceiptPayload(payload: ReceiptPayload): string {
  return canonicalJson(payload);
}

function cryptoSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available in this environment');
  return subtle;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await cryptoSubtle().digest('SHA-256', utf8Encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export async function receiptPayloadHash(payload: ReceiptPayload): Promise<string> {
  return sha256Hex(canonicalReceiptPayload(payload));
}

/** Human-friendly code printed on receipts and sent by SMS, e.g. "3FA9-0B1C". */
export function shortVerificationCode(payloadHash: string): string {
  const code = payloadHash.slice(0, 8).toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface ReceiptQrData {
  payload: ReceiptPayload;
  signature: string;
}

/** QR content: "<verifyUrl>#<base64url(json)>". The fragment never reaches a server. */
export function encodeReceiptQr(verifyBaseUrl: string, data: ReceiptQrData): string {
  const json = canonicalJson({ p: data.payload, s: data.signature });
  return `${verifyBaseUrl}#${bytesToBase64Url(utf8Encode(json))}`;
}

export function decodeReceiptQr(content: string): ReceiptQrData {
  const fragment = content.includes('#') ? content.slice(content.indexOf('#') + 1) : content;
  const parsed = JSON.parse(utf8Decode(base64UrlToBytes(fragment.trim()))) as {
    p?: ReceiptPayload;
    s?: string;
  };
  if (!parsed.p || typeof parsed.s !== 'string') {
    throw new Error('QR code does not contain a receipt');
  }
  return { payload: parsed.p, signature: parsed.s };
}

export type ReceiptPublicKeys = Record<string, string>;

export type ReceiptVerificationResult =
  | { valid: true; payloadHash: string; verificationCode: string }
  | { valid: false; reason: 'unknown_key' | 'bad_signature' | 'malformed' };

/**
 * Verifies an Ed25519 receipt signature with WebCrypto. Works in modern browsers and Node.js,
 * with no network access, so receipts stay verifiable when the platform is offline.
 * publicKeys maps key id -> raw 32-byte Ed25519 public key in base64url.
 */
export async function verifyReceiptSignature(
  publicKeys: ReceiptPublicKeys,
  data: ReceiptQrData,
): Promise<ReceiptVerificationResult> {
  const rawKey = publicKeys[data.payload.kid];
  if (!rawKey) return { valid: false, reason: 'unknown_key' };
  try {
    const subtle = cryptoSubtle();
    const key = await subtle.importKey(
      'raw',
      base64UrlToBytes(rawKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const canonical = canonicalReceiptPayload(data.payload);
    const valid = await subtle.verify(
      { name: 'Ed25519' },
      key,
      base64UrlToBytes(data.signature),
      utf8Encode(canonical),
    );
    if (!valid) return { valid: false, reason: 'bad_signature' };
    const payloadHash = await sha256Hex(canonical);
    return { valid: true, payloadHash, verificationCode: shortVerificationCode(payloadHash) };
  } catch {
    return { valid: false, reason: 'malformed' };
  }
}
