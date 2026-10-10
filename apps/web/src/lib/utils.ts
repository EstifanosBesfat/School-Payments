import { etbStringToSantim } from '@payment/shared';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Addis_Ababa' }).format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Addis_Ababa',
  }).format(new Date(value));
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/** Converts a parent-facing ETB field ("1500.00") into integer santim for the API. */
export function parseEtbInput(value: string): number {
  try {
    const santim = etbStringToSantim(value);
    if (santim <= 0) throw new Error('Amount must be greater than zero');
    return santim;
  } catch {
    throw new Error('Enter an amount in ETB, for example 1500.00');
  }
}

export type FormState = { error?: string; success?: string };
