import { base32Decode, base32Encode, hotp, verifyTotp } from './totp';

describe('TOTP (RFC 6238)', () => {
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC 6238 SHA-1 test vectors (8 digits)', () => {
    expect(hotp(rfcSecret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(rfcSecret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(rfcSecret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
  });

  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(rfcSecret)).equals(rfcSecret)).toBe(true);
  });

  it('verifies current codes and rejects replays', () => {
    const secret = base32Encode(rfcSecret);
    const nowMs = 1_800_000_000_000;
    const step = Math.floor(nowMs / 30000);
    const code = hotp(rfcSecret, step);
    expect(verifyTotp(secret, code, { nowMs })).toBe(step);
    expect(verifyTotp(secret, code, { nowMs, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, '000000', { nowMs })).toBeNull();
  });
});
