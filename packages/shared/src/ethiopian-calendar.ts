const AMETE_MIHRET_JDN_EPOCH = 1723856;

export const ETHIOPIAN_MONTHS_AM = [
  'መስከረም',
  'ጥቅምት',
  'ኅዳር',
  'ታኅሣሥ',
  'ጥር',
  'የካቲት',
  'መጋቢት',
  'ሚያዝያ',
  'ግንቦት',
  'ሰኔ',
  'ሐምሌ',
  'ነሐሴ',
  'ጳጉሜ',
] as const;

export const ETHIOPIAN_MONTHS_EN = [
  'Meskerem',
  'Tikimt',
  'Hidar',
  'Tahsas',
  'Tir',
  'Yekatit',
  'Megabit',
  'Miyazya',
  'Ginbot',
  'Sene',
  'Hamle',
  'Nehase',
  'Pagume',
] as const;

export interface EthiopianDate {
  year: number;
  month: number;
  day: number;
}

function gregorianToJdn(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** Converts a Gregorian calendar date (year, 1-12, 1-31) to the Ethiopian calendar. */
export function gregorianToEthiopian(year: number, month: number, day: number): EthiopianDate {
  const jdn = gregorianToJdn(year, month, day);
  const offset = jdn - AMETE_MIHRET_JDN_EPOCH;
  const r = ((offset % 1461) + 1461) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  return {
    year: 4 * Math.floor(offset / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
    month: Math.floor(n / 30) + 1,
    day: (n % 30) + 1,
  };
}

/** Calendar date in Ethiopia (UTC+3, no daylight saving) for an instant. */
export function eatDateParts(instant: Date): { year: number; month: number; day: number } {
  const shifted = new Date(instant.getTime() + 3 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function formatEthiopianDate(instant: Date, language: 'am' | 'en' = 'en'): string {
  const { year, month, day } = eatDateParts(instant);
  const et = gregorianToEthiopian(year, month, day);
  const names = language === 'am' ? ETHIOPIAN_MONTHS_AM : ETHIOPIAN_MONTHS_EN;
  return `${names[et.month - 1]} ${et.day}, ${et.year} ${language === 'am' ? 'ዓ.ም.' : 'E.C.'}`;
}

/** "2026-10-09 14:05 EAT" */
export function formatEatDateTime(instant: Date): string {
  const shifted = new Date(instant.getTime() + 3 * 60 * 60 * 1000);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} EAT`;
}
