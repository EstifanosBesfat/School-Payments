import argon2 from 'argon2';

/** OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Spends the same time as a real check so unknown emails can't be detected by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= argon2.hash('timing-equalizer-password', OPTIONS);
  await verifyPassword(await dummyHash, password);
}
