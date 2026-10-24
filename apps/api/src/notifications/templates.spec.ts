import { addisDateOnly, smsTemplates } from './templates';

const sample = {
  school: 'Addis Demo Academy',
  student: 'Hana Tesfaye',
  amount: 450_000,
  link: 'https://pay.example/pay/token',
};

describe('receipt SMS', () => {
  it('names the rail and hides the provider', () => {
    const message = smsTemplates.receiptIssued('en', {
      ...sample,
      receiptNo: 'DEMO-1',
      code: '3FA9-0B1C',
      methodLabel: 'Telebirr',
    });
    const amharic = smsTemplates.receiptIssued('am', {
      ...sample,
      receiptNo: 'DEMO-1',
      code: '3FA9-0B1C',
      methodLabel: 'CBE Birr',
    });
    expect(message).toContain('by Telebirr');
    expect(amharic).toContain('በCBE Birr');
    expect(message.toLowerCase()).not.toContain('arifpay');
    expect(message.toLowerCase()).not.toContain('chapa');
    expect(amharic.toLowerCase()).not.toContain('arifpay');
    expect(amharic.toLowerCase()).not.toContain('chapa');
  });
});

describe('invoice reminder due dates', () => {
  const dueToday = addisDateOnly();
  const dueYesterday = addisDateOnly(new Date(), -1);

  it('keeps a reminder friendly on the due date itself', () => {
    const english = smsTemplates.invoiceReminder('en', { ...sample, dueDate: dueToday });
    const amharic = smsTemplates.invoiceReminder('am', { ...sample, dueDate: dueToday });
    expect(english).toContain('are due');
    expect(english).not.toContain('were due');
    expect(amharic).toContain('እስከ');
    expect(amharic).not.toContain('አልፏል');
  });

  it('says the deadline has passed only after that Addis Ababa day', () => {
    const english = smsTemplates.invoiceReminder('en', { ...sample, dueDate: dueYesterday });
    const amharic = smsTemplates.invoiceReminder('am', { ...sample, dueDate: dueYesterday });
    expect(english).toContain('were due');
    expect(amharic).toContain('አልፏል');
  });

  it('does not treat 09:00 in Addis Ababa on the due date as overdue', () => {
    const due = new Date('2026-10-10T00:00:00.000Z');
    jest.useFakeTimers({ now: new Date('2026-10-10T06:00:00.000Z') });
    try {
      expect(smsTemplates.invoiceReminder('en', { ...sample, dueDate: due })).toContain('are due');
      jest.setSystemTime(new Date('2026-10-10T21:30:00.000Z'));
      expect(smsTemplates.invoiceReminder('en', { ...sample, dueDate: due })).toContain('were due');
    } finally {
      jest.useRealTimers();
    }
  });
});
