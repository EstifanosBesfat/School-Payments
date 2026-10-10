// Generates an Ed25519 key pair for signing receipts. Paste the output into the root .env.
// Keep the private key secret; publish the public key so anyone can verify receipts offline.
const { generateKeyPairSync } = require('node:crypto');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const now = new Date();
const keyId = `key-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

console.log(`RECEIPT_SIGNING_KEY_ID=${keyId}`);
console.log(`RECEIPT_SIGNING_PRIVATE_KEY=${Buffer.from(privatePem).toString('base64')}`);
console.log(`RECEIPT_SIGNING_PUBLIC_KEY=${publicKey.export({ format: 'jwk' }).x}`);
