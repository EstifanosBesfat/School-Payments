import { formatEtb, formatEthiopianDate, type Language } from '@payment/shared';

const ADDIS_ABABA = 'Africa/Addis_Ababa';

/** Civil date in Addis Ababa, YYYY-MM-DD. */
export function addisCalendarDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ADDIS_ABABA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

/** UTC midnight of an Addis Ababa civil date, suitable for a Postgres `date` column. */
export function addisDateOnly(now = new Date(), offsetDays = 0): Date {
  const [year, month, day] = addisCalendarDate(now).split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + offsetDays));
}

/**
 * Invoice due dates are calendar dates. The deadline has passed only after that whole day in
 * Addis Ababa, not at 00:00 UTC (which is still evening the day before in Ethiopia).
 */
export function dueDatePassed(dueDate: Date, now = new Date()): boolean {
  return dueDate.toISOString().slice(0, 10) < addisCalendarDate(now);
}

function gregorian(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Addis_Ababa' }).format(date);
}

function birr(santim: number, language: Language): string {
  const value = formatEtb(santim).replace('ETB ', '');
  return language === 'am' ? `${value} ብር` : `ETB ${value}`;
}

function date(value: Date, language: Language): string {
  return language === 'am' ? formatEthiopianDate(value, 'am') : gregorian(value);
}

export interface InvoiceMessageData {
  school: string;
  student: string;
  term?: string | null;
  amount: number;
  dueDate: Date;
  link: string;
}

export interface ReceiptMessageData {
  school: string;
  student: string;
  amount: number;
  receiptNo: string;
  code: string;
  link: string;
}

export const smsTemplates = {
  invoiceIssued(language: Language, data: InvoiceMessageData): string {
    const term = data.term ? ` ${data.term}` : '';
    return language === 'am'
      ? `${data.school}: የ${data.student}${term} ክፍያ ${birr(data.amount, 'am')}፣ የመጨረሻ ቀን ${date(data.dueDate, 'am')}። ለመክፈል: ${data.link}`
      : `${data.school}: ${data.student}${term} fees ${birr(data.amount, 'en')}, due ${date(data.dueDate, 'en')}. Pay: ${data.link}`;
  },

  invoiceReminder(language: Language, data: InvoiceMessageData): string {
    const overdue = dueDatePassed(data.dueDate);
    if (language === 'am') {
      return overdue
        ? `${data.school}: ማስታወሻ - የ${data.student} ክፍያ ${birr(data.amount, 'am')} የመጨረሻ ቀኑ (${date(data.dueDate, 'am')}) አልፏል። ለመክፈል: ${data.link}`
        : `${data.school}: ማስታወሻ - የ${data.student} ክፍያ ${birr(data.amount, 'am')} እስከ ${date(data.dueDate, 'am')} ድረስ ይክፈሉ። ለመክፈል: ${data.link}`;
    }
    return overdue
      ? `${data.school}: Reminder - ${data.student} fees of ${birr(data.amount, 'en')} were due ${date(data.dueDate, 'en')}. Pay: ${data.link}`
      : `${data.school}: Reminder - ${data.student} fees of ${birr(data.amount, 'en')} are due ${date(data.dueDate, 'en')}. Pay: ${data.link}`;
  },

  receiptIssued(language: Language, data: ReceiptMessageData): string {
    return language === 'am'
      ? `${data.school}: የ${data.student} ክፍያ ${birr(data.amount, 'am')} ደርሶናል። ደረሰኝ ${data.receiptNo}፣ ማረጋገጫ ${data.code}። ${data.link}`
      : `${data.school}: Received ${birr(data.amount, 'en')} for ${data.student}. Receipt ${data.receiptNo}, code ${data.code}. ${data.link}`;
  },

  parentOtp(language: Language, code: string): string {
    return language === 'am'
      ? `የማረጋገጫ ኮድዎ ${code} ነው። ለ5 ደቂቃ ያገለግላል። ለማንም አያጋሩ።`
      : `Your verification code is ${code}. It expires in 5 minutes. Do not share it.`;
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

export const emailTemplates = {
  receiptIssued(data: ReceiptMessageData & { payerName: string; paidAt: Date }) {
    const subject = `Payment receipt ${data.receiptNo} - ${data.school}`;
    const text = [
      `Dear ${data.payerName},`,
      '',
      `${data.school} received ${birr(data.amount, 'en')} for ${data.student} on ${gregorian(data.paidAt)} (${formatEthiopianDate(data.paidAt, 'en')}).`,
      `Receipt number: ${data.receiptNo}`,
      `Verification code: ${data.code}`,
      '',
      `The signed PDF receipt is attached. Keep it: anyone can verify it, even offline, at ${data.link}`,
    ].join('\n');
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111827">
<p>Dear ${escapeHtml(data.payerName)},</p>
<p><strong>${escapeHtml(data.school)}</strong> received <strong>${escapeHtml(birr(data.amount, 'en'))}</strong> for ${escapeHtml(data.student)} on ${escapeHtml(gregorian(data.paidAt))} (${escapeHtml(formatEthiopianDate(data.paidAt, 'en'))}).</p>
<table style="border-collapse:collapse"><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Receipt number</td><td><strong>${escapeHtml(data.receiptNo)}</strong></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280">Verification code</td><td><strong>${escapeHtml(data.code)}</strong></td></tr></table>
<p>The signed PDF receipt is attached. Keep it as proof of payment. You can verify it at any time, even offline, at <a href="${escapeHtml(data.link)}">${escapeHtml(data.link)}</a>.</p>
</body></html>`;
    return { subject, text, html };
  },
};
