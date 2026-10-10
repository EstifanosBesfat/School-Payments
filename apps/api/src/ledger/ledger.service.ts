import { Injectable } from '@nestjs/common';
import type { LedgerAccount, LedgerDirection } from '@payment/db';
import { assertSantim } from '@payment/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService, type Tx } from '../prisma/prisma.service';

export interface LedgerLine {
  account: LedgerAccount;
  direction: LedgerDirection;
  amount: number;
}

export interface LedgerPosting {
  schoolId: string;
  memo: string;
  paymentId?: string;
  invoiceId?: string;
  lines: LedgerLine[];
}

export class UnbalancedLedgerError extends Error {
  constructor(debits: number, credits: number) {
    super(`Ledger posting is unbalanced: debits ${debits} != credits ${credits}`);
  }
}

export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new Error('A ledger posting needs at least two lines');
  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    assertSantim(line.amount);
    if (line.amount <= 0) throw new Error('Ledger line amounts must be positive');
    if (line.direction === 'DEBIT') debits += line.amount;
    else credits += line.amount;
  }
  if (debits !== credits) throw new UnbalancedLedgerError(debits, credits);
}

/**
 * Double-entry bookkeeping. Accounts:
 *  STUDENT_RECEIVABLE  money families owe (debit when invoiced, credit when paid)
 *  FEE_REVENUE         fees the school earned (credit when invoiced)
 *  GATEWAY_CLEARING    money held by the gateway before settlement to the school's bank
 *  GATEWAY_FEES        gateway charges
 *  PLATFORM_COMMISSION platform share routed by split payment
 *  REFUNDS             money returned to payers
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(tx: Tx, posting: LedgerPosting): Promise<string> {
    const lines = posting.lines.filter((line) => line.amount !== 0);
    assertBalanced(lines);
    const transactionId = randomUUID();
    await tx.ledgerEntry.createMany({
      data: lines.map((line) => ({
        schoolId: posting.schoolId,
        transactionId,
        paymentId: posting.paymentId,
        invoiceId: posting.invoiceId,
        account: line.account,
        direction: line.direction,
        amount: line.amount,
        memo: posting.memo,
      })),
    });
    return transactionId;
  }

  invoiceIssued(tx: Tx, schoolId: string, invoiceId: string, amount: number, memo: string): Promise<string> {
    return this.post(tx, {
      schoolId,
      invoiceId,
      memo,
      lines: [
        { account: 'STUDENT_RECEIVABLE', direction: 'DEBIT', amount },
        { account: 'FEE_REVENUE', direction: 'CREDIT', amount },
      ],
    });
  }

  invoiceCancelled(tx: Tx, schoolId: string, invoiceId: string, amount: number, memo: string): Promise<string> {
    return this.post(tx, {
      schoolId,
      invoiceId,
      memo,
      lines: [
        { account: 'FEE_REVENUE', direction: 'DEBIT', amount },
        { account: 'STUDENT_RECEIVABLE', direction: 'CREDIT', amount },
      ],
    });
  }

  paymentSucceeded(
    tx: Tx,
    input: { schoolId: string; invoiceId: string; paymentId: string; amount: number; gatewayFee: number; platformFee: number; memo: string },
  ): Promise<string> {
    const lines: LedgerLine[] = [
      { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amount: input.amount },
      { account: 'STUDENT_RECEIVABLE', direction: 'CREDIT', amount: input.amount },
    ];
    if (input.gatewayFee > 0) {
      lines.push(
        { account: 'GATEWAY_FEES', direction: 'DEBIT', amount: input.gatewayFee },
        { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amount: input.gatewayFee },
      );
    }
    if (input.platformFee > 0) {
      lines.push(
        { account: 'PLATFORM_COMMISSION', direction: 'DEBIT', amount: input.platformFee },
        { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amount: input.platformFee },
      );
    }
    return this.post(tx, { schoolId: input.schoolId, invoiceId: input.invoiceId, paymentId: input.paymentId, memo: input.memo, lines });
  }

  paymentRefunded(
    tx: Tx,
    input: { schoolId: string; invoiceId: string; paymentId: string; amount: number; memo: string },
  ): Promise<string> {
    return this.post(tx, {
      schoolId: input.schoolId,
      invoiceId: input.invoiceId,
      paymentId: input.paymentId,
      memo: input.memo,
      lines: [
        { account: 'REFUNDS', direction: 'DEBIT', amount: input.amount },
        { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amount: input.amount },
      ],
    });
  }

  /** Balance per account for a school: debits minus credits. */
  async balances(schoolId: string): Promise<Record<LedgerAccount, number>> {
    const rows = await this.prisma.tenant(schoolId, (tx) =>
      tx.ledgerEntry.groupBy({
        by: ['account', 'direction'],
        where: { schoolId },
        _sum: { amount: true },
      }),
    );
    const result: Record<LedgerAccount, number> = {
      STUDENT_RECEIVABLE: 0,
      FEE_REVENUE: 0,
      GATEWAY_CLEARING: 0,
      GATEWAY_FEES: 0,
      PLATFORM_COMMISSION: 0,
      REFUNDS: 0,
    };
    for (const row of rows) {
      const amount = row._sum.amount ?? 0;
      result[row.account] += row.direction === 'DEBIT' ? amount : -amount;
    }
    return result;
  }
}
