/**
 * Ethiopian mobile numbers: Ethio Telecom uses 09xxxxxxxx, Safaricom Ethiopia uses 07xxxxxxxx.
 * We store E.164 (+2519xxxxxxxx / +2517xxxxxxxx) and convert at provider boundaries.
 */
const E164_PATTERN = /^\+251[79]\d{8}$/;

export function normalizeEthiopianPhone(input: string): string {
  const digits = input.replace(/[\s\-().]/g, '');
  let local: string;
  if (/^\+251[79]\d{8}$/.test(digits)) {
    local = digits.slice(4);
  } else if (/^251[79]\d{8}$/.test(digits)) {
    local = digits.slice(3);
  } else if (/^0[79]\d{8}$/.test(digits)) {
    local = digits.slice(1);
  } else if (/^[79]\d{8}$/.test(digits)) {
    local = digits;
  } else {
    throw new Error('Phone number must be an Ethiopian mobile number, e.g. 0912345678');
  }
  return `+251${local}`;
}

export function isEthiopianPhone(input: string): boolean {
  try {
    normalizeEthiopianPhone(input);
    return true;
  } catch {
    return false;
  }
}

/** +251912345678 -> 0912345678 (Chapa format). */
export function toLocalPhone(e164: string): string {
  if (!E164_PATTERN.test(e164)) throw new Error('Expected E.164 Ethiopian phone number');
  return `0${e164.slice(4)}`;
}

/** +251912345678 -> 251912345678 (GeezSMS and ArifPay direct-pay format). */
export function toInternationalDigits(e164: string): string {
  if (!E164_PATTERN.test(e164)) throw new Error('Expected E.164 Ethiopian phone number');
  return e164.slice(1);
}

/** Telebirr wallets are Ethio Telecom numbers (+2519…). Safaricom (+2517…) is not a Telebirr number. */
export function isTelebirrPhone(e164: string): boolean {
  return /^\+2519\d{8}$/.test(e164);
}

/** +251912345678 -> +2519****5678 (safe for logs and receipts). */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '****';
  return `${e164.slice(0, 5)}****${e164.slice(-4)}`;
}
