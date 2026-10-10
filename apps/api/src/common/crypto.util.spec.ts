import { randomBytes } from 'node:crypto';
import { randomReference, safeEqual, SecretBox } from './crypto.util';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));

  it('round-trips secrets', () => {
    const envelope = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(envelope.startsWith('v1.')).toBe(true);
    expect(box.decrypt(envelope)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const [version, iv, tag, ciphertext] = box.encrypt('secret').split('.');
    const flipped = Buffer.from(ciphertext!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => box.decrypt([version, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('helpers', () => {
  it('compares strings safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('creates gateway-safe references', () => {
    const reference = randomReference(14);
    expect(reference).toMatch(/^[A-Z0-9]{14}$/);
  });
});
