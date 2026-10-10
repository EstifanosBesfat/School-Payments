import { assertBalanced, UnbalancedLedgerError } from './ledger.service';

describe('assertBalanced', () => {
  it('accepts balanced postings', () => {
    expect(() =>
      assertBalanced([
        { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amount: 150000 },
        { account: 'STUDENT_RECEIVABLE', direction: 'CREDIT', amount: 150000 },
        { account: 'GATEWAY_FEES', direction: 'DEBIT', amount: 4500 },
        { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amount: 4500 },
      ]),
    ).not.toThrow();
  });

  it('rejects unbalanced postings', () => {
    expect(() =>
      assertBalanced([
        { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amount: 150000 },
        { account: 'STUDENT_RECEIVABLE', direction: 'CREDIT', amount: 149999 },
      ]),
    ).toThrow(UnbalancedLedgerError);
  });

  it('rejects fractional and non-positive amounts', () => {
    expect(() =>
      assertBalanced([
        { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amount: 10.5 },
        { account: 'STUDENT_RECEIVABLE', direction: 'CREDIT', amount: 10.5 },
      ]),
    ).toThrow();
    expect(() =>
      assertBalanced([
        { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amount: -5 },
        { account: 'STUDENT_RECEIVABLE', direction: 'CREDIT', amount: -5 },
      ]),
    ).toThrow();
  });
});
