import type { Account, AccountType } from './accounts.ts';
import { assertDate } from './dates.ts';
import type { Ledger } from './ledger.ts';

/** One line of a statement. Parents carry the rolled-up total of their sub-accounts. */
export interface StatementRow {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  /** 0 for top-level accounts, 1 for their children, and so on. */
  readonly depth: number;
  readonly isLeaf: boolean;
  /** In the section's natural sign: contra accounts show as negative. */
  readonly amount: bigint;
}

export interface StatementSection {
  readonly rows: readonly StatementRow[];
  readonly total: bigint;
}

export interface TrialBalanceRow {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface TrialBalance {
  readonly asOf: string | undefined;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: bigint;
  readonly totalCredit: bigint;
  readonly balanced: boolean;
}

export interface IncomeStatement {
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly revenue: StatementSection;
  readonly expenses: StatementSection;
  readonly netIncome: bigint;
}

export interface BalanceSheet {
  readonly asOf: string | undefined;
  readonly assets: StatementSection;
  readonly liabilities: StatementSection;
  /** Equity accounts plus `currentEarnings`, the profit of periods not yet closed. */
  readonly equity: StatementSection & { readonly currentEarnings: bigint };
  /** Assets equal liabilities plus equity. Always true for a ledger built by this library. */
  readonly balanced: boolean;
}

export interface GeneralLedgerRow {
  readonly date: string;
  readonly entryId: string;
  readonly description: string;
  readonly account: string;
  readonly memo: string | undefined;
  readonly debit: bigint;
  readonly credit: bigint;
  /** Running balance in the account's normal sign. */
  readonly balance: bigint;
}

export interface GeneralLedger {
  readonly account: Account;
  readonly opening: bigint;
  readonly rows: readonly GeneralLedgerRow[];
  readonly closing: bigint;
}

/** Debit and credit balance of every account with activity, as of a day. */
export function trialBalance(ledger: Ledger, options: { asOf?: string } = {}): TrialBalance {
  const balances = ledger.balances(options.asOf === undefined ? {} : { to: options.asOf });
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const account of ledger.accounts.list()) {
    const balance = balances.get(account.code) ?? 0n;
    if (balance === 0n) continue;
    const debit = balance > 0n ? balance : 0n;
    const credit = balance < 0n ? -balance : 0n;
    totalDebit += debit;
    totalCredit += credit;
    rows.push({ code: account.code, name: account.name, type: account.type, debit, credit });
  }
  return {
    asOf: options.asOf,
    rows,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

/** Revenue, expenses and net income for a range of days. Closing entries are left out. */
export function incomeStatement(
  ledger: Ledger,
  options: { from?: string; to?: string } = {},
): IncomeStatement {
  const balances = ledger.balances({ ...options, excludeClosing: true });
  const revenue = section(ledger, balances, 'revenue', -1n);
  const expenses = section(ledger, balances, 'expense', 1n);
  return {
    from: options.from,
    to: options.to,
    revenue,
    expenses,
    netIncome: revenue.total - expenses.total,
  };
}

/** Assets, liabilities and equity at the end of a day. */
export function balanceSheet(ledger: Ledger, options: { asOf?: string } = {}): BalanceSheet {
  const balances = ledger.balances(options.asOf === undefined ? {} : { to: options.asOf });
  const assets = section(ledger, balances, 'asset', 1n);
  const liabilities = section(ledger, balances, 'liability', -1n);
  const equityAccounts = section(ledger, balances, 'equity', -1n);
  const currentEarnings =
    section(ledger, balances, 'revenue', -1n).total -
    section(ledger, balances, 'expense', 1n).total;
  const equityTotal = equityAccounts.total + currentEarnings;
  return {
    asOf: options.asOf,
    assets,
    liabilities,
    equity: { rows: equityAccounts.rows, total: equityTotal, currentEarnings },
    balanced: assets.total === liabilities.total + equityTotal,
  };
}

/**
 * Every posting to an account (and its sub-accounts) in date order, with an opening balance and
 * a running balance in the account's normal sign.
 */
export function generalLedger(
  ledger: Ledger,
  code: string,
  options: { from?: string; to?: string } = {},
): GeneralLedger {
  const account = ledger.accounts.get(code);
  const from = options.from === undefined ? undefined : assertDate(options.from, 'from');
  const to = options.to === undefined ? undefined : assertDate(options.to, 'to');
  const codes = new Set([code, ...ledger.accounts.descendants(code).map((a) => a.code)]);
  const sign = account.normal === 'debit' ? 1n : -1n;
  const entries = [...ledger.entries].sort((a, b) =>
    a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1,
  );

  let opening = 0n;
  let running = 0n;
  const rows: GeneralLedgerRow[] = [];
  for (const entry of entries) {
    if (to !== undefined && entry.date > to) break;
    for (const line of entry.lines) {
      if (!codes.has(line.account)) continue;
      if (from !== undefined && entry.date < from) {
        opening += line.amount * sign;
        running = opening;
        continue;
      }
      running += line.amount * sign;
      rows.push({
        date: entry.date,
        entryId: entry.id,
        description: entry.description,
        account: line.account,
        memo: line.memo,
        debit: line.amount > 0n ? line.amount : 0n,
        credit: line.amount < 0n ? -line.amount : 0n,
        balance: running,
      });
    }
  }
  return { account, opening, rows, closing: running };
}

function section(
  ledger: Ledger,
  balances: ReadonlyMap<string, bigint>,
  type: AccountType,
  sign: 1n | -1n,
): StatementSection {
  const chart = ledger.accounts;
  const rolled = new Map<string, bigint>();
  const active = new Set<string>();
  let total = 0n;
  for (const [code, balance] of balances) {
    const account = chart.get(code);
    if (account.type !== type || balance === 0n) continue;
    total += balance * sign;
    let current: Account | undefined = account;
    while (current !== undefined) {
      rolled.set(current.code, (rolled.get(current.code) ?? 0n) + balance * sign);
      active.add(current.code);
      current = current.parent === undefined ? undefined : chart.get(current.parent);
    }
  }

  const rows: StatementRow[] = [];
  const visit = (account: Account, depth: number) => {
    if (!active.has(account.code)) return;
    const children = chart.children(account.code);
    rows.push({
      code: account.code,
      name: account.name,
      type: account.type,
      depth,
      isLeaf: children.length === 0,
      amount: rolled.get(account.code) ?? 0n,
    });
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of chart.roots()) if (root.type === type) visit(root, 0);
  return { rows, total };
}
