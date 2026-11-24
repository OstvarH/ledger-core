import { expect } from 'vitest';
import type { AccountInput } from '../src/accounts.ts';
import { LedgerError, type LedgerErrorCode } from '../src/errors.ts';
import { Ledger } from '../src/ledger.ts';

/** A small business chart with a sub-account tree and a contra account. */
export const CHART: AccountInput[] = [
  { code: '1000', name: 'Current assets', type: 'asset' },
  { code: '1010', name: 'Bank', type: 'asset', parent: '1000' },
  { code: '1100', name: 'Accounts receivable', type: 'asset', parent: '1000' },
  { code: '1500', name: 'Equipment', type: 'asset' },
  { code: '1590', name: 'Accumulated depreciation', type: 'asset', contra: true },
  { code: '2000', name: 'Accounts payable', type: 'liability' },
  { code: '2100', name: 'Sales tax payable', type: 'liability' },
  { code: '3000', name: 'Owner capital', type: 'equity' },
  { code: '3100', name: 'Retained earnings', type: 'equity' },
  { code: '4000', name: 'Consulting revenue', type: 'revenue' },
  { code: '4900', name: 'Sales returns', type: 'revenue', contra: true },
  { code: '5000', name: 'Operating expenses', type: 'expense' },
  { code: '5010', name: 'Rent', type: 'expense', parent: '5000' },
  { code: '5020', name: 'Software', type: 'expense', parent: '5000' },
  { code: '5100', name: 'Depreciation', type: 'expense' },
];

export function newLedger(): Ledger {
  return new Ledger({ currency: 'CAD', accounts: CHART });
}

/** A month of activity: capital, a sale on credit, collection, expenses, depreciation. */
export function januaryLedger(): Ledger {
  const ledger = newLedger();
  ledger.post({
    date: '2026-01-02',
    description: 'Owner investment',
    lines: [
      { account: '1010', debit: '20000.00' },
      { account: '3000', credit: '20000.00' },
    ],
  });
  ledger.post({
    date: '2026-01-03',
    description: 'Laptop',
    lines: [
      { account: '1500', debit: '2400.00' },
      { account: '1010', credit: '2400.00' },
    ],
  });
  ledger.post({
    date: '2026-01-10',
    description: 'Invoice INV-001',
    lines: [
      { account: '1100', debit: '5650.00' },
      { account: '4000', credit: '5000.00' },
      { account: '2100', credit: '650.00', memo: 'HST 13%' },
    ],
  });
  ledger.post({
    date: '2026-01-15',
    description: 'Rent for January',
    lines: [
      { account: '5010', debit: '1500.00' },
      { account: '1010', credit: '1500.00' },
    ],
  });
  ledger.post({
    date: '2026-01-20',
    description: 'Design tool subscription',
    lines: [
      { account: '5020', debit: '49.99' },
      { account: '2000', credit: '49.99' },
    ],
  });
  ledger.post({
    date: '2026-01-25',
    description: 'Payment for INV-001',
    lines: [
      { account: '1010', debit: '5650.00' },
      { account: '1100', credit: '5650.00' },
    ],
  });
  ledger.post({
    date: '2026-01-31',
    description: 'Laptop depreciation',
    lines: [
      { account: '5100', debit: '66.67' },
      { account: '1590', credit: '66.67' },
    ],
  });
  return ledger;
}

export function expectLedgerError(fn: () => unknown, code: LedgerErrorCode): LedgerError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerError);
  expect((caught as LedgerError).code).toBe(code);
  return caught as LedgerError;
}
