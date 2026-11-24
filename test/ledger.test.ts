import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.ts';
import { expectLedgerError, januaryLedger, newLedger } from './fixtures.ts';

const receivable = { account: '1100', debit: '1000.00' };
const revenue = { account: '4000', credit: '1000.00' };
const sale = {
  date: '2026-02-01',
  description: 'Invoice INV-002',
  lines: [receivable, revenue],
};

describe('posting', () => {
  it('assigns gap-free ids and stores signed minor units', () => {
    const ledger = newLedger();
    const first = ledger.post(sale);
    const second = ledger.post({ ...sale, description: 'Invoice INV-003' });
    expect(first.id).toBe('JE-000001');
    expect(second.id).toBe('JE-000002');
    expect(first.lines).toEqual([
      { account: '1100', amount: 100000n },
      { account: '4000', amount: -100000n },
    ]);
    expect(first.kind).toBe('standard');
  });

  it('returns frozen entries that cannot be edited', () => {
    const entry = newLedger().post(sale);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.lines)).toBe(true);
    expect(Object.isFrozen(entry.lines[0])).toBe(true);
  });

  it('rejects an entry that does not balance and says by how much', () => {
    const error = expectLedgerError(
      () =>
        newLedger().post({
          ...sale,
          lines: [
            { account: '1100', debit: '1000.00' },
            { account: '4000', credit: '999.99' },
          ],
        }),
      'UNBALANCED',
    );
    expect(error.message).toContain('debits exceed credits by 0.01');
  });

  it('enforces the shape of every line', () => {
    const ledger = newLedger();
    expectLedgerError(() => ledger.post({ ...sale, lines: [receivable] }), 'INVALID_ENTRY');
    expectLedgerError(
      () =>
        ledger.post({
          ...sale,
          lines: [{ account: '1100', debit: '1', credit: '1' }, revenue],
        }),
      'INVALID_ENTRY',
    );
    expectLedgerError(
      () =>
        ledger.post({
          ...sale,
          lines: [
            { account: '1100', debit: '0' },
            { account: '4000', credit: '0' },
          ],
        }),
      'INVALID_AMOUNT',
    );
    expectLedgerError(
      () =>
        ledger.post({
          ...sale,
          lines: [
            { account: '1100', debit: '-5' },
            { account: '4000', debit: '5' },
          ],
        }),
      'INVALID_AMOUNT',
    );
    expectLedgerError(
      () =>
        ledger.post({
          ...sale,
          lines: [
            { account: '9999', debit: '1' },
            { account: '4000', credit: '1' },
          ],
        }),
      'UNKNOWN_ACCOUNT',
    );
    expectLedgerError(() => ledger.post({ ...sale, description: '   ' }), 'INVALID_ENTRY');
    expectLedgerError(() => ledger.post({ ...sale, date: '2026-02-30' }), 'INVALID_DATE');
  });

  it('only posts to leaf accounts', () => {
    expectLedgerError(
      () =>
        newLedger().post({
          ...sale,
          lines: [
            { account: '5000', debit: '10' },
            { account: '1010', credit: '10' },
          ],
        }),
      'NOT_POSTABLE',
    );
  });

  it('refuses a sub-account under an account that already has postings', () => {
    const ledger = newLedger();
    ledger.post(sale);
    expectLedgerError(
      () => ledger.addAccount({ code: '4010', name: 'Retainers', type: 'revenue', parent: '4000' }),
      'NOT_POSTABLE',
    );
  });

  it('allows the same account on both sides, as a reclass does', () => {
    const entry = newLedger().post({
      ...sale,
      lines: [
        { account: '1010', debit: '10' },
        { account: '1010', credit: '10' },
      ],
    });
    expect(entry.lines).toHaveLength(2);
  });
});

describe('idempotency', () => {
  it('returns the original entry when the same key is posted again', () => {
    const ledger = newLedger();
    const first = ledger.post({ ...sale, idempotencyKey: 'stripe:evt_1' });
    const again = ledger.post({ ...sale, idempotencyKey: 'stripe:evt_1' });
    expect(again).toBe(first);
    expect(ledger.entries).toHaveLength(1);
  });

  it('refuses the same key with different content', () => {
    const ledger = newLedger();
    ledger.post({ ...sale, idempotencyKey: 'k1' });
    expectLedgerError(
      () => ledger.post({ ...sale, description: 'Something else', idempotencyKey: 'k1' }),
      'IDEMPOTENCY_CONFLICT',
    );
  });
});

describe('reversal', () => {
  it('cancels an entry without touching it', () => {
    const ledger = newLedger();
    const original = ledger.post(sale);
    const reversal = ledger.reverse(original.id, { date: '2026-02-05' });
    expect(reversal.kind).toBe('reversal');
    expect(reversal.reverses).toBe(original.id);
    expect(reversal.description).toBe(`Reversal of ${original.id}`);
    expect(reversal.lines.map((l) => l.amount)).toEqual([-100000n, 100000n]);
    expect(ledger.entry(original.id)).toBe(original);
    expect(ledger.reversalOf(original.id)).toBe(reversal);
    expect(ledger.balance('1100')).toBe(0n);
    expect(ledger.balance('1100', { to: '2026-02-04' })).toBe(100000n);
  });

  it('reverses once, never before the original date, and not reversals themselves', () => {
    const ledger = newLedger();
    const original = ledger.post(sale);
    expectLedgerError(() => ledger.reverse(original.id, { date: '2026-01-31' }), 'INVALID_DATE');
    const reversal = ledger.reverse(original.id);
    expectLedgerError(() => ledger.reverse(original.id), 'ALREADY_REVERSED');
    expectLedgerError(() => ledger.reverse(reversal.id), 'INVALID_ENTRY');
    expectLedgerError(() => ledger.reverse('JE-999999'), 'UNKNOWN_ENTRY');
  });
});

describe('period close', () => {
  it('moves net income to retained earnings and locks the period', () => {
    const ledger = januaryLedger();
    const result = ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    // 5000.00 revenue - 1500.00 rent - 49.99 software - 66.67 depreciation
    expect(ledger.format(result.netIncome)).toBe('3383.34');
    expect(result.entry?.kind).toBe('closing');
    expect(ledger.balance('3100')).toBe(-338334n);
    expect(ledger.balance('4000')).toBe(0n);
    expect(ledger.balance('5000')).toBe(0n);
    expect(ledger.lockedThrough).toBe('2026-01-31');
  });

  it('blocks postings and reversals into the closed period but not after it', () => {
    const ledger = januaryLedger();
    ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    expectLedgerError(() => ledger.post({ ...sale, date: '2026-01-31' }), 'PERIOD_LOCKED');
    expectLedgerError(() => ledger.reverse('JE-000003'), 'PERIOD_LOCKED');
    expect(ledger.reverse('JE-000003', { date: '2026-02-01' }).kind).toBe('reversal');
    expect(ledger.post(sale).date).toBe('2026-02-01');
  });

  it('still honours an idempotent retry of an entry now in a closed period', () => {
    const ledger = newLedger();
    const original = ledger.post({ ...sale, date: '2026-01-10', idempotencyKey: 'k' });
    ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    expect(ledger.post({ ...sale, date: '2026-01-10', idempotencyKey: 'k' })).toBe(original);
  });

  it('cannot close the same period twice or into a non-equity account', () => {
    const ledger = januaryLedger();
    expectLedgerError(
      () => ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '1010' }),
      'INVALID_ACCOUNT',
    );
    ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    expectLedgerError(
      () => ledger.closePeriod({ through: '2026-01-15', retainedEarnings: '3100' }),
      'PERIOD_LOCKED',
    );
  });

  it('closes a period with no income activity without an entry', () => {
    const ledger = newLedger();
    const result = ledger.closePeriod({ through: '2025-12-31', retainedEarnings: '3100' });
    expect(result.entry).toBeUndefined();
    expect(result.netIncome).toBe(0n);
    expect(ledger.lockedThrough).toBe('2025-12-31');
  });
});

describe('snapshots', () => {
  it('round-trips through JSON and rebuilds the same ledger', () => {
    const ledger = januaryLedger();
    ledger.reverse('JE-000005', { date: '2026-01-31', description: 'Cancelled subscription' });
    ledger.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
    ledger.post({ ...sale, idempotencyKey: 'inv-002' });

    const json = JSON.stringify(ledger);
    const restored = Ledger.fromJSON(JSON.parse(json));
    expect(restored.entries).toEqual(ledger.entries);
    expect(restored.balances()).toEqual(ledger.balances());
    expect(restored.lockedThrough).toBe('2026-01-31');
    expect(restored.accounts.list()).toEqual(ledger.accounts.list());
    // the idempotency index is rebuilt too
    expect(restored.post({ ...sale, idempotencyKey: 'inv-002' }).id).toBe('JE-000010');
  });

  it('rejects snapshots that break the rules', () => {
    const snapshot = januaryLedger().toJSON();
    const event = snapshot.events.find((e) => e.type === 'post');
    const line = event?.type === 'post' ? event.lines[0] : undefined;
    if (!line) throw new Error('the fixture has no posting');
    line.debit = '1.00';
    expectLedgerError(() => Ledger.fromJSON(snapshot), 'INVALID_SNAPSHOT');
    expectLedgerError(
      () => Ledger.fromJSON({ format: 'other' } as unknown as ReturnType<Ledger['toJSON']>),
      'INVALID_SNAPSHOT',
    );
  });
});

describe('ledger options', () => {
  it('supports currencies with other precisions', () => {
    const ledger = new Ledger({
      currency: 'IRR',
      decimals: 0,
      accounts: [
        { code: '1', name: 'Cash', type: 'asset' },
        { code: '4', name: 'Sales', type: 'revenue' },
      ],
    });
    ledger.post({
      date: '2026-03-21',
      description: 'Nowruz sale',
      lines: [
        { account: '1', debit: '15000000' },
        { account: '4', credit: '15000000' },
      ],
    });
    expect(ledger.format(ledger.balance('1'))).toBe('15000000');
    expectLedgerError(() => ledger.parse('1.5'), 'INVALID_AMOUNT');
  });

  it('validates the currency', () => {
    expectLedgerError(() => new Ledger({ currency: 'usd' }), 'INVALID_CURRENCY');
    expectLedgerError(() => new Ledger({ currency: 'USD', decimals: 9 }), 'INVALID_CURRENCY');
  });

  it('accepts bigint minor units and exact numbers', () => {
    const entry = newLedger().post({
      ...sale,
      lines: [
        { account: '1100', debit: 1999n },
        { account: '4000', credit: 19.99 },
      ],
    });
    expect(entry.lines[1]?.amount).toBe(-1999n);
  });
});
