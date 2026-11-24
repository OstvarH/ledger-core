import { LedgerError } from './errors.ts';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Accounting dates are calendar days written as YYYY-MM-DD, with no time or zone. That makes them
 * compare correctly as plain strings, which the ledger relies on.
 */
export function assertDate(value: string, label = 'date'): string {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return value;
    }
  }
  throw new LedgerError(
    'INVALID_DATE',
    `${label} must be a calendar date as YYYY-MM-DD, got "${value}"`,
  );
}
