# ledger-core

[![CI](https://github.com/OstvarH/ledger-core/actions/workflows/ci.yml/badge.svg)](https://github.com/OstvarH/ledger-core/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

A small, strict **double-entry accounting engine** for TypeScript. It keeps the books the way an
accountant expects, and it refuses to let them go wrong.

- **Exact money.** Amounts are `bigint` minor units parsed straight from decimal strings. No
  floating point anywhere, and `"1.005"` in a two-decimal currency is an error, not a rounding.
- **Every entry balances.** Debits equal credits, amounts are positive, postings go to leaf
  accounts only. An unbalanced entry is rejected with the exact difference.
- **An immutable journal.** Entries are frozen and numbered without gaps (`JE-000001`, ...).
  Mistakes are corrected with reversals, so the audit trail is never rewritten.
- **Period close.** Closing moves revenue and expenses into retained earnings and locks the period.
- **Financial statements.** Trial balance, income statement, balance sheet and general ledger, with
  sub-account roll-ups and contra accounts.
- **Safe retries.** Idempotency keys turn a duplicate webhook into a no-op instead of a double booking.
- **Storage-agnostic.** The ledger is an event log. `toJSON()` exports it, `Ledger.fromJSON()`
  replays it and re-checks every rule on the way.
- **Zero runtime dependencies**, ESM, fully typed.

The accounting invariants are tested with property-based tests: thousands of random ledgers, and
the books must balance every time.

## Install

```sh
pnpm add github:OstvarH/ledger-core
```

Node 22 or later.

## Quick start

```ts
import { Ledger, balanceSheet, incomeStatement } from 'ledger-core';

const books = new Ledger({
  currency: 'CAD',
  accounts: [
    { code: '1010', name: 'Bank', type: 'asset' },
    { code: '1100', name: 'Accounts receivable', type: 'asset' },
    { code: '2100', name: 'HST payable', type: 'liability' },
    { code: '3100', name: 'Retained earnings', type: 'equity' },
    { code: '4000', name: 'Consulting revenue', type: 'revenue' },
    { code: '5010', name: 'Rent', type: 'expense' },
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

const report = incomeStatement(books, { from: '2026-01-01', to: '2026-01-31' });
books.format(report.netIncome); // "5000.00"

books.closePeriod({ through: '2026-01-31', retainedEarnings: '3100' });
balanceSheet(books).balanced; // true
```

A complete month, with a correction, a close and every statement, is in
[`examples/quickstart.ts`](examples/quickstart.ts). Run it with `pnpm example`:

```text
Income statement, January 2026
  Revenue
    4000 Consulting revenue             5000.00
    Total                               5000.00
  Expenses
    5000 Operating expenses             1549.00
      5010 Rent                         1500.00
      5020 Software                       49.00
    Total                               1549.00
  Net income                            3451.00

Closed January: 3451.00 moved to retained earnings.
...
Posting into the closed month is refused: 2026-01-31 is in a closed period (closed through 2026-01-31)
```

## Concepts

### Amounts

| Input     | Meaning                                |
| --------- | -------------------------------------- |
| `'12.34'` | a decimal string, the recommended form |
| `12.34`   | a number, accepted only if it is exact |
| `1234n`   | a bigint, already in minor units       |

Internally every amount is a signed `bigint`: positive for debits, negative for credits. Use
`ledger.format(amount)` to print one and `ledger.parse(text)` to read one. The precision comes from
`decimals` (2 by default, 0 for currencies such as JPY or IRR, up to 8).

`allocate(total, weights)` splits an amount without losing a cent, for example a payment across
invoices or a cost across departments:

```ts
allocate(10000n, [1, 1, 1]); // [3334n, 3333n, 3333n]
```

### Accounts

Five types, each with a normal side: assets and expenses increase with debits; liabilities, equity
and revenue with credits. Accounts can be nested (`parent`), and a sub-account must have the same
type as its parent. Only leaf accounts take postings; parents roll up in reports. A `contra`
account carries the opposite balance of its type: accumulated depreciation, sales returns.

### Corrections

A posted entry is never changed. `ledger.reverse(id)` posts its mirror image and links the two,
then you post the correct entry. Reversals can be dated later than the original (for example into
an open period), never earlier.

### Closing a period

`closePeriod({ through, retainedEarnings })` posts one closing entry that zeroes every revenue and
expense account into retained earnings, then locks every day up to `through`. Posting or reversing
into a locked day fails with `PERIOD_LOCKED`. Income statements leave closing entries out, so a
closed month still reports its profit, and the balance sheet shows unclosed profit as
`currentEarnings` so it balances before and after a close.

### Persistence

```ts
const snapshot = books.toJSON(); // plain JSON: currency, precision and an ordered event log
await db.save(JSON.stringify(snapshot));

const restored = Ledger.fromJSON(JSON.parse(await db.load()));
```

The snapshot stores what happened (`account`, `post`, `reverse`, `close`) rather than the
resulting balances, so a restored ledger is rebuilt by the same rules that built the original. A
tampered snapshot that breaks a rule fails with `INVALID_SNAPSHOT`.

### Errors

Every failure is a `LedgerError` with a machine-readable `code`:

`INVALID_AMOUNT` · `INVALID_DATE` · `INVALID_CURRENCY` · `INVALID_ACCOUNT` · `DUPLICATE_ACCOUNT` ·
`UNKNOWN_ACCOUNT` · `NOT_POSTABLE` · `INVALID_ENTRY` · `UNBALANCED` · `PERIOD_LOCKED` ·
`IDEMPOTENCY_CONFLICT` · `UNKNOWN_ENTRY` · `ALREADY_REVERSED` · `INVALID_SNAPSHOT`

```ts
try {
  books.post(entry);
} catch (error) {
  if (error instanceof LedgerError && error.code === 'UNBALANCED') {
    // show error.message: "The entry does not balance: debits exceed credits by 0.01"
  }
}
```

## API

| Function / method                                   | Returns                                     |
| --------------------------------------------------- | ------------------------------------------- |
| `new Ledger({ currency, decimals?, accounts? })`    | a ledger                                    |
| `ledger.addAccount(input)`                          | the frozen `Account`                        |
| `ledger.post(entry)`                                | the frozen `Entry`                          |
| `ledger.reverse(id, { date?, description? })`       | the reversal `Entry`                        |
| `ledger.closePeriod({ through, retainedEarnings })` | `{ entry, netIncome }`                      |
| `ledger.balance(code, { from?, to? })`              | rolled-up balance, debit positive           |
| `ledger.balances({ from?, to?, excludeClosing? })`  | `Map` of leaf balances                      |
| `ledger.entry(id)`, `ledger.reversalOf(id)`         | an entry                                    |
| `ledger.toJSON()`, `Ledger.fromJSON(snapshot)`      | snapshot / ledger                           |
| `trialBalance(ledger, { asOf? })`                   | rows, totals, `balanced`                    |
| `incomeStatement(ledger, { from?, to? })`           | revenue, expenses, `netIncome`              |
| `balanceSheet(ledger, { asOf? })`                   | assets, liabilities, equity, `balanced`     |
| `generalLedger(ledger, code, { from?, to? })`       | opening, rows with running balance, closing |
| `parseAmount`, `formatAmount`, `allocate`           | money helpers                               |

## Scope

ledger-core is deliberately an engine, not an application. It keeps one currency per ledger and
holds everything in memory, which is fine for one company's books for many years. Not yet built:
multi-currency with exchange gains and losses, and tax-specific reports.

## Development

```sh
pnpm install
pnpm test        # unit and property-based tests
pnpm check       # lint, typecheck, test and build, as CI runs it
pnpm example
```

## License

MIT
