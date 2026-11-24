import { describe, expect, it } from 'vitest';
import { balanceSheet, generalLedger, incomeStatement, trialBalance } from '../src/reports.ts';
import { januaryLedger } from './fixtures.ts';

describe('trialBalance', () => {
  it('lists every leaf with a balance and totals that agree', () => {
    const tb = trialBalance(januaryLedger());
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.map((r) => [r.code, r.debit, r.credit])).toEqual([
      ['1010', 2175000n, 0n],
      ['1500', 240000n, 0n],
      ['1590', 0n, 6667n],
      ['2000', 0n, 4999n],
      ['2100', 0n, 65000n],
      ['3000', 0n, 2000000n],
      ['4000', 0n, 500000n],
      ['5010', 150000n, 0n],
      ['5020', 4999n, 0n],
      ['5100', 6667n, 0n],
    ]);
  });

  it('can be taken as of an earlier day', () => {
    const tb = trialBalance(januaryLedger(), { asOf: '2026-01-03' });
    expect(tb.rows.map((r) => r.code)).toEqual(['1010', '1500', '3000']);
  });
});

describe('incomeStatement', () => {
  it('rolls sub-accounts up into their parents', () => {
    const report = incomeStatement(januaryLedger(), { from: '2026-01-01', to: '2026-01-31' });
    expect(report.revenue.total).toBe(500000n);
    expect(report.expenses.total).toBe(161666n);
    expect(report.netIncome).toBe(338334n);
    expect(report.expenses.rows.map((r) => [r.code, r.depth, r.isLeaf, r.amount])).toEqual([
      ['5000', 0, false, 154999n],
      ['5010', 1, true, 150000n],
      ['5020', 1, true, 4999n],
      ['5100', 0, true, 6667n],
    ]);
  });

  it('shows contra revenue as a negative line', () => {
    const ledger = januaryLedger();
    ledger.post({
      date: '2026-01-28',
      description: 'Credit note CN-001',
      lines: [
        { account: '4900', debit: '200.00' },
        { account: '1010', credit: '200.00' },
      ],
    });
    const report = incomeStatement(ledger);
    expect(report.revenue.rows.find((r) => r.code === '4900')?.amount).toBe(-20000n);
    expect(report.revenue.total).toBe(480000n);
  });

  it('still reports a closed period, because closing entries are excluded', () => {
    const ledger = januaryLedger();
    ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    expect(incomeStatement(ledger, { from: '2026-01-01', to: '2026-01-31' }).netIncome).toBe(
      338334n,
    );
  });
});

describe('balanceSheet', () => {
  it('balances, showing unclosed profit as current earnings', () => {
    const sheet = balanceSheet(januaryLedger());
    expect(sheet.balanced).toBe(true);
    expect(sheet.assets.total).toBe(2408333n);
    expect(sheet.liabilities.total).toBe(69999n);
    expect(sheet.equity.currentEarnings).toBe(338334n);
    expect(sheet.equity.total).toBe(2338334n);
    // accumulated depreciation is a contra asset and reduces total assets
    expect(sheet.assets.rows.find((r) => r.code === '1590')?.amount).toBe(-6667n);
  });

  it('moves profit into retained earnings once the period is closed', () => {
    const ledger = januaryLedger();
    ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    const sheet = balanceSheet(ledger);
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.currentEarnings).toBe(0n);
    expect(sheet.equity.rows.find((r) => r.code === '3100')?.amount).toBe(338334n);
  });
});

describe('generalLedger', () => {
  it('shows a running balance in the account normal sign', () => {
    const gl = generalLedger(januaryLedger(), '1010');
    expect(gl.opening).toBe(0n);
    expect(gl.rows.map((r) => r.balance)).toEqual([2000000n, 1760000n, 1610000n, 2175000n]);
    expect(gl.closing).toBe(2175000n);
  });

  it('starts from an opening balance and includes sub-accounts of a parent', () => {
    const gl = generalLedger(januaryLedger(), '1000', { from: '2026-01-11', to: '2026-01-31' });
    expect(gl.opening).toBe(2325000n);
    expect(gl.rows.map((r) => [r.date, r.account, r.debit, r.credit])).toEqual([
      ['2026-01-15', '1010', 0n, 150000n],
      ['2026-01-25', '1010', 565000n, 0n],
      ['2026-01-25', '1100', 0n, 565000n],
    ]);
    expect(gl.closing).toBe(2175000n);
  });

  it('presents credit-normal accounts as positive balances', () => {
    const gl = generalLedger(januaryLedger(), '2100');
    expect(gl.closing).toBe(65000n);
  });
});
