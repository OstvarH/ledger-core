import { describe, expect, it } from 'vitest';
import { ChartOfAccounts } from '../src/accounts.ts';
import { assertDate } from '../src/dates.ts';
import { LedgerError } from '../src/errors.ts';

const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof LedgerError ? error.code : 'NOT_A_LEDGER_ERROR';
  }
  return 'NO_ERROR';
};

describe('ChartOfAccounts', () => {
  it('derives the normal side from the type and the contra flag', () => {
    const chart = new ChartOfAccounts();
    expect(chart.add({ code: '1000', name: 'Cash', type: 'asset' }).normal).toBe('debit');
    expect(chart.add({ code: '2000', name: 'Payables', type: 'liability' }).normal).toBe('credit');
    expect(chart.add({ code: '4000', name: 'Sales', type: 'revenue' }).normal).toBe('credit');
    expect(chart.add({ code: '5000', name: 'Rent', type: 'expense' }).normal).toBe('debit');
    const contra = chart.add({
      code: '1590',
      name: 'Accumulated depreciation',
      type: 'asset',
      contra: true,
    });
    expect(contra.normal).toBe('credit');
  });

  it('builds a tree and knows which accounts are leaves', () => {
    const chart = new ChartOfAccounts();
    chart.add({ code: '1000', name: 'Current assets', type: 'asset' });
    chart.add({ code: '1010', name: 'Bank', type: 'asset', parent: '1000' });
    chart.add({ code: '1020', name: 'Petty cash', type: 'asset', parent: '1000' });
    chart.add({ code: '1011', name: 'Bank USD', type: 'asset', parent: '1010' });
    expect(chart.isLeaf('1000')).toBe(false);
    expect(chart.isLeaf('1020')).toBe(true);
    expect(chart.children('1000').map((a) => a.code)).toEqual(['1010', '1020']);
    expect(chart.descendants('1000').map((a) => a.code)).toEqual(['1010', '1011', '1020']);
    expect(chart.roots().map((a) => a.code)).toEqual(['1000']);
  });

  it('rejects bad accounts', () => {
    const chart = new ChartOfAccounts();
    chart.add({ code: '1000', name: 'Cash', type: 'asset' });
    expect(errorCode(() => chart.add({ code: '1000', name: 'Again', type: 'asset' }))).toBe(
      'DUPLICATE_ACCOUNT',
    );
    expect(errorCode(() => chart.add({ code: ' 1', name: 'Space', type: 'asset' }))).toBe(
      'INVALID_ACCOUNT',
    );
    expect(errorCode(() => chart.add({ code: '1100', name: '  ', type: 'asset' }))).toBe(
      'INVALID_ACCOUNT',
    );
    expect(
      errorCode(() => chart.add({ code: '1100', name: 'X', type: 'cash' as unknown as 'asset' })),
    ).toBe('INVALID_ACCOUNT');
    expect(
      errorCode(() => chart.add({ code: '1100', name: 'X', type: 'asset', parent: '9999' })),
    ).toBe('UNKNOWN_ACCOUNT');
    expect(
      errorCode(() => chart.add({ code: '1100', name: 'X', type: 'expense', parent: '1000' })),
    ).toBe('INVALID_ACCOUNT');
    expect(errorCode(() => chart.get('nope'))).toBe('UNKNOWN_ACCOUNT');
  });

  it('returns frozen accounts', () => {
    const chart = new ChartOfAccounts();
    const account = chart.add({ code: '1000', name: 'Cash', type: 'asset' });
    expect(Object.isFrozen(account)).toBe(true);
  });
});

describe('assertDate', () => {
  it('accepts real calendar days', () => {
    expect(assertDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects impossible or badly written dates', () => {
    for (const bad of ['2023-02-29', '2024-13-01', '2024-1-5', '2024-01-05T00:00:00Z', '']) {
      expect(errorCode(() => assertDate(bad))).toBe('INVALID_DATE');
    }
  });
});
