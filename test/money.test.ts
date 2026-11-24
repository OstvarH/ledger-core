import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/errors.ts';
import { allocate, assertCurrency, formatAmount, parseAmount } from '../src/money.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof LedgerError ? error.code : 'NOT_A_LEDGER_ERROR';
  }
  return 'NO_ERROR';
};

describe('parseAmount', () => {
  it('reads decimal strings exactly', () => {
    expect(parseAmount('12.34', 2)).toBe(1234n);
    expect(parseAmount('12.3', 2)).toBe(1230n);
    expect(parseAmount('12', 2)).toBe(1200n);
    expect(parseAmount(' -0.05 ', 2)).toBe(-5n);
    expect(parseAmount('1000000000000000000.01', 2)).toBe(100000000000000000001n);
  });

  it('handles currencies without minor units and with three decimals', () => {
    expect(parseAmount('15000', 0)).toBe(15000n);
    expect(parseAmount('1.234', 3)).toBe(1234n);
  });

  it('accepts numbers only when they are exact at the precision', () => {
    expect(parseAmount(12.5, 2)).toBe(1250n);
    expect(code(() => parseAmount(0.1 + 0.2, 2))).toBe('INVALID_AMOUNT');
    expect(code(() => parseAmount(Number.NaN, 2))).toBe('INVALID_AMOUNT');
  });

  it('treats bigints as minor units', () => {
    expect(parseAmount(99n, 2)).toBe(99n);
  });

  it('refuses to round', () => {
    expect(code(() => parseAmount('1.005', 2))).toBe('INVALID_AMOUNT');
    expect(code(() => parseAmount('1.5', 0))).toBe('INVALID_AMOUNT');
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '1,000.00', '1e3', '.5', '5.', '--1', '$5']) {
      expect(code(() => parseAmount(bad, 2))).toBe('INVALID_AMOUNT');
    }
  });
});

describe('formatAmount', () => {
  it('formats minor units', () => {
    expect(formatAmount(1234n, 2)).toBe('12.34');
    expect(formatAmount(5n, 2)).toBe('0.05');
    expect(formatAmount(-5n, 2)).toBe('-0.05');
    expect(formatAmount(0n, 2)).toBe('0.00');
    expect(formatAmount(15000n, 0)).toBe('15000');
  });
});

describe('allocate', () => {
  it('never loses or invents a cent', () => {
    expect(allocate(100n, [1, 1, 1])).toEqual([34n, 33n, 33n]);
    expect(allocate(-100n, [1, 1, 1])).toEqual([-34n, -33n, -33n]);
    expect(allocate(5n, [70, 30])).toEqual([4n, 1n]);
    expect(allocate(0n, [1, 2])).toEqual([0n, 0n]);
  });

  it('gives remainders to the largest fractional share first', () => {
    // exact shares: 1.666.., 3.333.. -> the second has the larger remainder
    expect(allocate(5n, [1, 2])).toEqual([2n, 3n]);
  });

  it('keeps zero weights at zero', () => {
    expect(allocate(10n, [0, 1, 0])).toEqual([0n, 10n, 0n]);
  });

  it('validates weights', () => {
    expect(code(() => allocate(10n, []))).toBe('INVALID_AMOUNT');
    expect(code(() => allocate(10n, [0, 0]))).toBe('INVALID_AMOUNT');
    expect(code(() => allocate(10n, [1.5]))).toBe('INVALID_AMOUNT');
    expect(code(() => allocate(10n, [-1, 2]))).toBe('INVALID_AMOUNT');
  });
});

describe('assertCurrency', () => {
  it('accepts three capital letters only', () => {
    expect(assertCurrency('CAD')).toBe('CAD');
    expect(code(() => assertCurrency('cad'))).toBe('INVALID_CURRENCY');
    expect(code(() => assertCurrency('DOLLARS'))).toBe('INVALID_CURRENCY');
  });
});
