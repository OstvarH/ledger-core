/**
 * Property-based tests: fast-check generates thousands of random ledgers and the accounting
 * invariants must hold for every one of them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.ts';
import { allocate, formatAmount, parseAmount } from '../src/money.ts';
import { balanceSheet, generalLedger, incomeStatement, trialBalance } from '../src/reports.ts';
import { CHART, newLedger } from './fixtures.ts';

const LEAVES = CHART.filter((a) => !CHART.some((b) => b.parent === a.code)).map((a) => a.code);

const day = fc
  .integer({ min: 0, max: 364 })
  .map((offset) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10));

/** A balanced entry: several transfers of an amount from one leaf account to another. */
const entry = fc
  .record({
    date: day,
    transfers: fc.array(
      fc.record({
        from: fc.constantFrom(...LEAVES),
        to: fc.constantFrom(...LEAVES),
        cents: fc.bigInt({ min: 1n, max: 10_000_000n }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  })
  .map(({ date, transfers }) => ({
    date,
    description: 'Generated entry',
    lines: transfers.flatMap((t) => [
      { account: t.to, debit: t.cents },
      { account: t.from, credit: t.cents },
    ]),
  }));

const entries = fc.array(entry, { minLength: 0, maxLength: 30 });

function build(inputs: Parameters<Ledger['post']>[0][]): Ledger {
  const ledger = newLedger();
  for (const input of inputs) ledger.post(input);
  return ledger;
}

describe('accounting invariants', () => {
  it('the trial balance always balances', () => {
    fc.assert(
      fc.property(entries, day, (inputs, asOf) => {
        const ledger = build(inputs);
        expect(trialBalance(ledger).balanced).toBe(true);
        expect(trialBalance(ledger, { asOf }).balanced).toBe(true);
      }),
    );
  });

  it('assets always equal liabilities plus equity, on any day', () => {
    fc.assert(
      fc.property(entries, day, (inputs, asOf) => {
        const ledger = build(inputs);
        expect(balanceSheet(ledger).balanced).toBe(true);
        expect(balanceSheet(ledger, { asOf }).balanced).toBe(true);
      }),
    );
  });

  it('reversing every entry brings every account back to zero', () => {
    fc.assert(
      fc.property(entries, (inputs) => {
        const ledger = build(inputs);
        for (const posted of ledger.entries) ledger.reverse(posted.id);
        for (const balance of ledger.balances().values()) expect(balance).toBe(0n);
      }),
    );
  });

  it('closing a period keeps the books balanced and preserves profit in equity', () => {
    fc.assert(
      fc.property(entries, day, (inputs, through) => {
        const ledger = build(inputs);
        const before = balanceSheet(ledger, { asOf: through });
        const profit = incomeStatement(ledger, { to: through }).netIncome;
        const result = ledger.closePeriod({ through, retainedEarnings: '3100' });
        const after = balanceSheet(ledger, { asOf: through });

        expect(result.netIncome).toBe(profit);
        expect(after.balanced).toBe(true);
        expect(after.equity.currentEarnings).toBe(0n);
        expect(after.equity.total).toBe(before.equity.total);
        expect(after.assets.total).toBe(before.assets.total);
        // the closed period's income statement is unchanged by the closing entry
        expect(incomeStatement(ledger, { to: through }).netIncome).toBe(profit);
      }),
    );
  });

  it('the general ledger closing balance matches the account balance', () => {
    fc.assert(
      fc.property(entries, fc.constantFrom(...CHART.map((a) => a.code)), (inputs, code) => {
        const ledger = build(inputs);
        const account = ledger.accounts.get(code);
        const sign = account.normal === 'debit' ? 1n : -1n;
        expect(generalLedger(ledger, code).closing).toBe(ledger.balance(code) * sign);
      }),
    );
  });

  it('a snapshot replays into an identical ledger', () => {
    fc.assert(
      fc.property(entries, (inputs) => {
        const ledger = build(inputs);
        const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger)));
        expect(restored.entries).toEqual(ledger.entries);
        expect(trialBalance(restored)).toEqual(trialBalance(ledger));
      }),
      { numRuns: 50 },
    );
  });
});

describe('money invariants', () => {
  it('allocate always returns exactly the total, each part within one unit of its share', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const parts = allocate(total, weights);
          const sum = weights.reduce((a, b) => a + b, 0);
          expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
          parts.forEach((part, i) => {
            // |part * sum - total * weight| < sum, i.e. less than one unit away from the share
            const gap = part * BigInt(sum) - total * BigInt(weights[i] ?? 0);
            expect(gap < 0n ? -gap : gap).toBeLessThan(BigInt(sum));
          });
        },
      ),
    );
  });

  it('formatting and parsing are inverses at every precision', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.integer({ min: 0, max: 8 }), (minor, decimals) => {
        expect(parseAmount(formatAmount(minor, decimals), decimals)).toBe(minor);
      }),
    );
  });
});
