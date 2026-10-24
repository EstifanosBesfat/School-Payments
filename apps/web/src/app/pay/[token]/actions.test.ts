import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startPaymentAction } from './actions';

const api = vi.fn();

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    const error = new Error(`NEXT_REDIRECT:${url}`);
    throw error;
  },
}));

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const parent = {
  payerName: 'Kebede Alemu',
  payerPhone: '0912345678',
  method: 'telebirr',
  idempotencyKey: 'key-1',
};

describe('startPaymentAction', () => {
  beforeEach(() => {
    api.mockReset();
  });

  it('redirects only when the start result is a hosted checkout', async () => {
    api.mockResolvedValue({ kind: 'redirect', txRef: 'DEMO-1', checkoutUrl: 'https://checkout.test/DEMO-1' });
    await expect(startPaymentAction('tok', {}, form(parent))).rejects.toThrow('NEXT_REDIRECT:https://checkout.test/DEMO-1');
  });

  it('sends a phone prompt to our status page instead of a provider URL', async () => {
    api.mockResolvedValue({ kind: 'phone_prompt', txRef: 'DEMO-1', method: 'telebirr', expiresAt: '2026-10-24T12:00:00.000Z' });
    await expect(startPaymentAction('tok', {}, form(parent))).rejects.toThrow('NEXT_REDIRECT:/pay/tok/prompt?tx=DEMO-1');
    expect(api).toHaveBeenCalledWith('/pay/tok/start', expect.objectContaining({ method: 'POST', auth: 'none' }));
  });

  it('rejects a 07 number for Telebirr before calling the API', async () => {
    const state = await startPaymentAction('tok', {}, form({ ...parent, payerPhone: '0712345678' }));
    expect(state.error).toMatch(/09/);
    expect(api).not.toHaveBeenCalled();
  });
});
