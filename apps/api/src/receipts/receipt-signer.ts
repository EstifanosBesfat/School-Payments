import { canonicalReceiptPayload, type ReceiptPayload, type ReceiptPublicKeys, receiptPayloadHash } from '@payment/shared';
import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';

export interface ReceiptSignerConfig {
  keyId: string;
  /** Base64 of the PKCS#8 PEM private key (see apps/api/scripts/generate-receipt-keys.js). */
  privateKeyPemBase64: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  /** JSON object of retired key id -> public key, so receipts signed with old keys still verify. */
  additionalPublicKeys?: string;
}

export interface SignedReceipt {
  payloadHash: string;
  signature: string;
}

export class ReceiptSigner {
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  private readonly keys: ReceiptPublicKeys;

  constructor(config: ReceiptSignerConfig) {
    this.keyId = config.keyId;
    this.privateKey = createPrivateKey(Buffer.from(config.privateKeyPemBase64, 'base64').toString('utf8'));
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('RECEIPT_SIGNING_PRIVATE_KEY must be an Ed25519 key');
    const derived = createPublicKey(this.privateKey).export({ format: 'jwk' }).x;
    if (derived !== config.publicKey) {
      throw new Error('RECEIPT_SIGNING_PUBLIC_KEY does not match RECEIPT_SIGNING_PRIVATE_KEY');
    }
    const additional = config.additionalPublicKeys ? (JSON.parse(config.additionalPublicKeys) as ReceiptPublicKeys) : {};
    this.keys = { ...additional, [config.keyId]: config.publicKey };
  }

  publicKeys(): ReceiptPublicKeys {
    return { ...this.keys };
  }

  async sign(payload: ReceiptPayload): Promise<SignedReceipt> {
    if (payload.kid !== this.keyId) throw new Error(`Payload key id ${payload.kid} does not match signer ${this.keyId}`);
    const canonical = canonicalReceiptPayload(payload);
    const signature = sign(null, Buffer.from(canonical, 'utf8'), this.privateKey).toString('base64url');
    return { payloadHash: await receiptPayloadHash(payload), signature };
  }
}
