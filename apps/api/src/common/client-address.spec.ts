import { apiKeyTracker, clientAddress, trustedProxySet } from './client-address';

const trusted = trustedProxySet('127.0.0.1, ::1');

function request(peer: string, forwarded?: string) {
  return {
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  };
}

describe('client address', () => {
  it('ignores a forwarded header from a peer that is not a trusted proxy', () => {
    const first = clientAddress(request('203.0.113.8', '198.51.100.1'), trusted);
    const second = clientAddress(request('203.0.113.8', '198.51.100.2'), trusted);
    expect(first).toBe('203.0.113.8');
    expect(second).toBe(first);
  });

  it('uses a single forwarded address when the peer is a trusted proxy', () => {
    expect(clientAddress(request('::ffff:127.0.0.1', '203.0.113.9'), trusted)).toBe('203.0.113.9');
    expect(clientAddress(request('127.0.0.1', '203.0.113.10'), trusted)).toBe('203.0.113.10');
  });

  it('rejects a forwarded chain so a client cannot prepend a fake address', () => {
    expect(clientAddress(request('127.0.0.1', '198.51.100.5, 203.0.113.9'), trusted)).toBe(
      '127.0.0.1',
    );
  });

  it('falls back to the peer when the forwarded value is not an IP', () => {
    expect(clientAddress(request('127.0.0.1', 'not-an-ip'), trusted)).toBe('127.0.0.1');
  });

  it('tracks an API key by a hash and not by the caller address', () => {
    const key = 'mock_stripe_key_1';
    const tracker = apiKeyTracker(key);
    expect(tracker).toBeTruthy();
    expect(tracker).not.toContain(key);
    expect(apiKeyTracker(key)).toBe(tracker);
    expect(apiKeyTracker('mock_stripe_key_2')).not.toBe(tracker);
    expect(apiKeyTracker(undefined)).toBeNull();
  });
});
