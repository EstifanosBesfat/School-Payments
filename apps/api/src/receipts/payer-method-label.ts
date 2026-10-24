const HIDDEN_GATEWAY_NAMES = new Set(['arifpay', 'chapa', 'mock']);

/** Parent-facing rail name. Provider names are never shown on a receipt or an SMS. */
export function payerMethodLabel(method: string | null | undefined): string {
  if (!method) return '';
  if (method === 'telebirr') return 'Telebirr';
  if (method === 'cbe_birr') return 'CBE Birr';
  if (HIDDEN_GATEWAY_NAMES.has(method.toLowerCase())) return '';
  return method;
}
