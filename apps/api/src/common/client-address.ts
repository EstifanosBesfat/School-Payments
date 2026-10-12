import { isIP } from 'node:net';
import { sha256Hex } from './crypto.util';

/** Map IPv4-mapped IPv6 (`::ffff:127.0.0.1`) onto the IPv4 form so proxy lists stay small. */
export function normalizeIp(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) {
    const mapped = trimmed.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return trimmed;
}

export function trustedProxySet(raw: string | undefined): ReadonlySet<string> {
  const proxies = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const ip = normalizeIp(part);
    if (ip && isIP(ip) !== 0) proxies.add(ip);
  }
  return proxies;
}

interface AddressRequest {
  ip?: string;
  socket?: { remoteAddress?: string | null };
  headers?: Record<string, string | string[] | undefined>;
}

function peerAddress(req: AddressRequest): string {
  return normalizeIp(req.socket?.remoteAddress ?? req.ip);
}

/**
 * Client address for rate limits and audit.
 * `X-Forwarded-For` counts only when the immediate peer is a configured proxy and the header
 * is a single IP (the proxy replaced any client-supplied chain). Otherwise the socket address is used.
 */
export function clientAddress(req: AddressRequest, trusted: ReadonlySet<string>): string {
  const peer = peerAddress(req);
  const fallback = peer || 'unknown';
  if (!peer || !trusted.has(peer)) return fallback;
  const header = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || raw.includes(',')) return fallback;
  const forwarded = normalizeIp(raw);
  if (!forwarded || isIP(forwarded) === 0) return fallback;
  return forwarded;
}

/** Stable tracker for an API key. The raw key never leaves this function. */
export function apiKeyTracker(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  return sha256Hex(raw);
}
