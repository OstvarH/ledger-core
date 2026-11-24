import { LedgerError } from './errors.ts';

/**
 * An amount as the caller writes it. Strings and numbers are decimal values ("12.34", 12.34);
 * a bigint is already in minor units (1234n is 12.34 with two decimals).
 */
export type AmountInput = string | number | bigint;

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Converts a decimal amount to integer minor units without ever going through floating point.
 * Rejects amounts with more decimal places than the currency allows instead of rounding them.
 */
export function parseAmount(input: AmountInput, decimals: number): bigint {
  if (typeof input === 'bigint') return input;
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new LedgerError('INVALID_AMOUNT', `Amount must be a finite number, got ${input}`);
    }
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    throw new LedgerError('INVALID_AMOUNT', `Amount must be a string, number or bigint`);
  }
  const match = DECIMAL.exec(text);
  if (!match) throw new LedgerError('INVALID_AMOUNT', `Not a decimal amount: "${text}"`);
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new LedgerError(
      'INVALID_AMOUNT',
      `"${text}" has more than ${decimals} decimal place${decimals === 1 ? '' : 's'}`,
    );
  }
  const minor = BigInt(whole + fraction.padEnd(decimals, '0'));
  return sign ? -minor : minor;
}

/** Formats minor units as a plain decimal string: formatAmount(-1234n, 2) === "-12.34". */
export function formatAmount(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Splits `total` minor units in proportion to integer `weights` so that the parts always add up
 * to exactly `total` (largest-remainder method). Ties go to the earlier weight, so the result is
 * deterministic. allocate(100n, [1, 1, 1]) -> [34n, 33n, 33n].
 */
export function allocate(total: bigint, weights: readonly (number | bigint)[]): bigint[] {
  if (weights.length === 0) {
    throw new LedgerError('INVALID_AMOUNT', 'allocate needs at least one weight');
  }
  const ws = weights.map((weight) => {
    if (typeof weight === 'number' && !Number.isSafeInteger(weight)) {
      throw new LedgerError('INVALID_AMOUNT', `Weights must be integers, got ${weight}`);
    }
    const value = BigInt(weight);
    if (value < 0n) throw new LedgerError('INVALID_AMOUNT', 'Weights cannot be negative');
    return value;
  });
  const sum = ws.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new LedgerError('INVALID_AMOUNT', 'At least one weight must be positive');

  const sign = total < 0n ? -1n : 1n;
  const absolute = total * sign;
  const parts = ws.map((w) => (absolute * w) / sum);
  let left = absolute - parts.reduce((a, b) => a + b, 0n);
  const byRemainder = ws
    .map((w, index) => ({ index, remainder: (absolute * w) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of byRemainder) {
    if (left === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts.map((part) => part * sign);
}

/** Validates an ISO 4217 style currency code ("CAD", "USD", "IRR"). */
export function assertCurrency(code: string): string {
  if (typeof code !== 'string' || !CURRENCY.test(code)) {
    throw new LedgerError(
      'INVALID_CURRENCY',
      `Currency must be three capital letters, got "${code}"`,
    );
  }
  return code;
}
