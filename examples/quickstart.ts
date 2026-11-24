/**
 * A month of a small consultancy's books, end to end. Run it with `pnpm example`
 * (Node 22.18+ runs TypeScript directly).
 */
import {
  balanceSheet,
  incomeStatement,
  Ledger,
  type StatementSection,
  trialBalance,
} from '../src/index.ts';

const books = new Ledger({
  currency: 'CAD',
  accounts: [
    { code: '1010', name: 'Bank', type: 'asset' },
    { code: '1100', name: 'Accounts receivable', type: 'asset' },
    { code: '2100', name: 'HST payable', type: 'liability' },
    { code: '3000', name: 'Owner capital', type: 'equity' },
    { code: '3100', name: 'Retained earnings', type: 'equity' },
    { code: '4000', name: 'Consulting revenue', type: 'revenue' },
    { code: '5000', name: 'Operating expenses', type: 'expense' },
    { code: '5010', name: 'Rent', type: 'expense', parent: '5000' },
    { code: '5020', name: 'Software', type: 'expense', parent: '5000' },
  ],
});

books.post({
  date: '2026-01-02',
  description: 'Owner investment',
  lines: [
    { account: '1010', debit: '10000.00' },
    { account: '3000', credit: '10000.00' },
  ],
});

books.post({
  date: '2026-01-10',
  description: 'Invoice INV-001',
  idempotencyKey: 'invoice:INV-001',
  lines: [
    { account: '1100', debit: '5650.00' },
    { account: '4000', credit: '5000.00' },
    { account: '2100', credit: '650.00', memo: 'HST 13%' },
  ],
});

books.post({
  date: '2026-01-15',
  description: 'January rent',
  lines: [
    { account: '5010', debit: '1500.00' },
    { account: '1010', credit: '1500.00' },
  ],
});

const subscription = books.post({
  date: '2026-01-20',
  description: 'Software subscription',
  lines: [
    { account: '5020', debit: '89.00' },
    { account: '1010', credit: '89.00' },
  ],
});

// Wrong amount: reverse it and post it again. Nothing is ever edited in place.
books.reverse(subscription.id, { description: 'Wrong plan, reversed' });
books.post({
  date: '2026-01-20',
  description: 'Software subscription (correct plan)',
  lines: [
    { account: '5020', debit: '49.00' },
    { account: '1010', credit: '49.00' },
  ],
});

books.post({
  date: '2026-01-28',
  description: 'Payment for INV-001',
  lines: [
    { account: '1010', debit: '5650.00' },
    { account: '1100', credit: '5650.00' },
  ],
});

const money = (amount: bigint) => books.format(amount).padStart(12);
const print = (title: string, section: StatementSection) => {
  console.log(`  ${title}`);
  for (const row of section.rows) {
    console.log(
      `    ${'  '.repeat(row.depth)}${row.code} ${row.name.padEnd(26 - row.depth * 2)}${money(row.amount)}`,
    );
  }
  console.log(`    ${'Total'.padEnd(31)}${money(section.total)}`);
};

console.log('\nIncome statement, January 2026');
const income = incomeStatement(books, { from: '2026-01-01', to: '2026-01-31' });
print('Revenue', income.revenue);
print('Expenses', income.expenses);
console.log(`  ${'Net income'.padEnd(33)}${money(income.netIncome)}`);

const { netIncome } = books.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
console.log(`\nClosed January: ${books.format(netIncome)} moved to retained earnings.`);

console.log('\nBalance sheet, 31 January 2026');
const sheet = balanceSheet(books, { asOf: '2026-01-31' });
print('Assets', sheet.assets);
print('Liabilities', sheet.liabilities);
print('Equity', sheet.equity);
console.log(`  Balanced: ${sheet.balanced}`);

const tb = trialBalance(books);
console.log(
  `\nTrial balance: ${books.format(tb.totalDebit)} Dr = ${books.format(tb.totalCredit)} Cr`,
);

try {
  books.post({
    date: '2026-01-31',
    description: 'Late January bill',
    lines: [
      { account: '5010', debit: '100.00' },
      { account: '1010', credit: '100.00' },
    ],
  });
} catch (error) {
  console.log(`\nPosting into the closed month is refused: ${(error as Error).message}`);
}
