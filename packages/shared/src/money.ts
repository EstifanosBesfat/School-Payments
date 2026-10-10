export const CURRENCY = 'ETB' as const;
export type Currency = typeof CURRENCY;

export function assertSantim(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Amount must be an integer number of santim, received ${value}`);
  }
}

/** 15000 -> "150.00" (the decimal string format gateways expect). */
export function santimToEtbString(santim: number): string {
  assertSantim(santim);
  const negative = santim < 0;
  const abs = Math.abs(santim);
  const birr = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${negative ? '-' : ''}${birr}.${cents.toString().padStart(2, '0')}`;
}

/** "150.00" | "150" | "150.5" -> 15050. Rejects more than two decimal places. */
export function etbStringToSantim(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid ETB amount: ${String(value)}`);
  }
  const [, sign, birr, fraction = ''] = match;
  const santim = Number(birr) * 100 + Number(fraction.padEnd(2, '0'));
  assertSantim(santim);
  return sign ? -santim : santim;
}

/** 150050 -> "ETB 1,500.50" */
export function formatEtb(santim: number): string {
  const [birr = '0', cents = '00'] = santimToEtbString(Math.abs(santim)).split('.');
  const grouped = birr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${santim < 0 ? '-' : ''}ETB ${grouped}.${cents}`;
}

export function sumSantim(values: readonly number[]): number {
  return values.reduce((total, value) => {
    assertSantim(value);
    const next = total + value;
    assertSantim(next);
    return next;
  }, 0);
}
