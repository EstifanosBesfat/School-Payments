import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PayForm } from './pay-form';

describe('PayForm', () => {
  it('offers Telebirr and CBE Birr in English and Amharic and hides provider names', () => {
    render(<PayForm token="tok" amountLabel="ETB 100.00" gateway="arifpay" />);
    expect(screen.getByText('Telebirr · ቴሌብር')).toBeTruthy();
    expect(screen.getByText('CBE Birr · ሲቢኢ ብር')).toBeTruthy();
    expect(screen.getByText('How do you want to pay? · የክፍያ መንገድ')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text.toLowerCase()).not.toContain('arifpay');
    expect(text.toLowerCase()).not.toContain('chapa');
  });

  it('hides method selection for hosted checkout gateways like Chapa', () => {
    render(<PayForm token="tok" amountLabel="ETB 100.00" gateway="chapa" />);
    expect(screen.queryByText('How do you want to pay? · የክፍያ መንገድ')).toBeNull();
    expect(screen.queryByText('Telebirr · ቴሌብር')).toBeNull();
    expect(screen.queryByText('CBE Birr · ሲቢኢ ብር')).toBeNull();
    expect(screen.getByLabelText(/full name/i)).toBeTruthy();
  });

  it('submits once when the pay button is clicked twice', async () => {
    const user = userEvent.setup();
    const startAction = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    render(<PayForm token="tok" amountLabel="ETB 100.00" gateway="chapa" startAction={startAction} />);
    await user.type(screen.getByLabelText(/full name/i), 'Kebede Alemu');
    await user.type(screen.getByLabelText(/phone number/i), '0912345678');
    const button = screen.getByRole('button', { name: /ክፈል/ });
    await user.click(button);
    await user.click(button);
    expect(startAction).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
