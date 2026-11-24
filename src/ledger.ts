import {
  type Account,
  type AccountInput,
  ChartOfAccounts,
  type ReadonlyChart,
} from './accounts.ts';
import { assertDate } from './dates.ts';
import { LedgerError } from './errors.ts';
import { type AmountInput, assertCurrency, formatAmount, parseAmount } from './money.ts';

export interface LineInput {
  account: string;
  debit?: AmountInput;
  credit?: AmountInput;
  memo?: string;
}

export interface EntryInput {
  /** Accounting date, YYYY-MM-DD. */
  date: string;
  description: string;
  lines: readonly LineInput[];
  /**
   * Makes posting safe to retry: posting the same key again returns the original entry, and
   * posting it with different content is an IDEMPOTENCY_CONFLICT.
   */
  idempotencyKey?: string;
}

export interface Line {
  readonly account: string;
  /** Minor units, signed: positive is a debit, negative is a credit. */
  readonly amount: bigint;
  readonly memo?: string;
}

export type EntryKind = 'standard' | 'reversal' | 'closing';

export interface Entry {
  /** Sequential and gap-free: JE-000001, JE-000002, ... */
  readonly id: string;
  readonly seq: number;
  readonly date: string;
  readonly description: string;
  readonly kind: EntryKind;
  readonly lines: readonly Line[];
  /** For a reversal, the id of the entry it cancels. */
  readonly reverses?: string;
  readonly idempotencyKey?: string;
}

export interface LedgerOptions {
  /** ISO 4217 code. A ledger keeps its books in one currency. */
  currency: string;
  /** Minor-unit digits: 2 for CAD or USD, 0 for JPY or IRR, 3 for KWD. Defaults to 2. */
  decimals?: number;
  accounts?: readonly AccountInput[];
}

export interface BalanceQuery {
  /** First day included. */
  from?: string;
  /** Last day included. */
  to?: string;
  /** Leave closing entries out, as an income statement must. */
  excludeClosing?: boolean;
}

export interface CloseResult {
  /** The closing entry, or undefined when there was nothing to close. */
  readonly entry: Entry | undefined;
  /** Net income moved to retained earnings, in minor units (negative for a loss). */
  readonly netIncome: bigint;
}

interface SerializedLine {
  account: string;
  debit?: string;
  credit?: string;
  memo?: string;
}

export type LedgerEvent =
  | { type: 'account'; account: AccountInput }
  | {
      type: 'post';
      date: string;
      description: string;
      lines: SerializedLine[];
      idempotencyKey?: string;
    }
  | { type: 'reverse'; id: string; date: string; description: string }
  | { type: 'close'; through: string; retainedEarnings: string };

/** A JSON-safe history of everything done to a ledger. Replaying it rebuilds the ledger exactly. */
export interface LedgerSnapshot {
  format: 'ledger-core/v1';
  currency: string;
  decimals: number;
  events: LedgerEvent[];
}

/**
 * A double-entry ledger kept in memory. Entries are immutable: mistakes are corrected with
 * reversals, and closed periods cannot take new postings. Persist it with toJSON() and rebuild it
 * with Ledger.fromJSON(), or store the events yourself.
 */
export class Ledger {
  readonly currency: string;
  readonly decimals: number;

  readonly #chart = new ChartOfAccounts();
  readonly #entries: Entry[] = [];
  readonly #byId = new Map<string, Entry>();
  readonly #byKey = new Map<string, { entry: Entry; fingerprint: string }>();
  readonly #reversedBy = new Map<string, string>();
  readonly #postedAccounts = new Set<string>();
  readonly #events: LedgerEvent[] = [];
  #lockedThrough: string | undefined;

  constructor(options: LedgerOptions) {
    this.currency = assertCurrency(options?.currency);
    const decimals = options.decimals ?? 2;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
      throw new LedgerError('INVALID_CURRENCY', `decimals must be an integer from 0 to 8`);
    }
    this.decimals = decimals;
    for (const account of options.accounts ?? []) this.addAccount(account);
  }

  /** The chart of accounts. Add accounts with addAccount(). */
  get accounts(): ReadonlyChart {
    return this.#chart;
  }

  /** All entries in the order they were posted. */
  get entries(): readonly Entry[] {
    return [...this.#entries];
  }

  /** The last closed day, if any period has been closed. */
  get lockedThrough(): string | undefined {
    return this.#lockedThrough;
  }

  addAccount(input: AccountInput): Account {
    if (input?.parent !== undefined && this.#postedAccounts.has(input.parent)) {
      throw new LedgerError(
        'NOT_POSTABLE',
        `Cannot add ${input.code} under ${input.parent}: ${input.parent} already has postings`,
      );
    }
    const account = this.#chart.add(input);
    this.#events.push({ type: 'account', account: toAccountInput(account) });
    return account;
  }

  entry(id: string): Entry {
    const entry = this.#byId.get(id);
    if (!entry) throw new LedgerError('UNKNOWN_ENTRY', `Entry ${id} does not exist`);
    return entry;
  }

  /** The reversal that cancelled entry `id`, if there is one. */
  reversalOf(id: string): Entry | undefined {
    const reversalId = this.#reversedBy.get(this.entry(id).id);
    return reversalId === undefined ? undefined : this.#byId.get(reversalId);
  }

  post(input: EntryInput): Entry {
    if (input === null || typeof input !== 'object') {
      throw new LedgerError('INVALID_ENTRY', 'An entry must be an object');
    }
    const date = assertDate(input.date);
    const description = requireText(input.description, 'An entry needs a description');
    const lines = this.#normalizeLines(input.lines);

    const key = input.idempotencyKey;
    let fingerprint: string | undefined;
    if (key !== undefined) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new LedgerError('INVALID_ENTRY', 'idempotencyKey must be a non-empty string');
      }
      fingerprint = fingerprintOf(date, description, lines);
      const prior = this.#byKey.get(key);
      if (prior) {
        if (prior.fingerprint === fingerprint) return prior.entry;
        throw new LedgerError(
          'IDEMPOTENCY_CONFLICT',
          `Key "${key}" was already used for ${prior.entry.id} with different content`,
        );
      }
    }

    this.#assertOpen(date);
    const entry = this.#append({
      date,
      description,
      lines,
      kind: 'standard',
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    });
    if (key !== undefined && fingerprint !== undefined)
      this.#byKey.set(key, { entry, fingerprint });
    this.#events.push({
      type: 'post',
      date,
      description,
      lines: lines.map((line) => this.#serializeLine(line)),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    });
    return entry;
  }

  /**
   * Cancels a posted entry with an equal and opposite one. The original stays in the journal, so
   * the audit trail is never rewritten. The reversal defaults to the original's date.
   */
  reverse(id: string, options: { date?: string; description?: string } = {}): Entry {
    const original = this.entry(id);
    if (original.kind !== 'standard') {
      throw new LedgerError(
        'INVALID_ENTRY',
        `${id} is a ${original.kind} entry and cannot be reversed`,
      );
    }
    const existing = this.#reversedBy.get(id);
    if (existing !== undefined) {
      throw new LedgerError('ALREADY_REVERSED', `${id} was already reversed by ${existing}`);
    }
    const date = assertDate(options.date ?? original.date);
    if (date < original.date) {
      throw new LedgerError(
        'INVALID_DATE',
        `The reversal of ${id} cannot be dated before the entry itself (${original.date})`,
      );
    }
    this.#assertOpen(date);
    const description =
      options.description === undefined
        ? `Reversal of ${id}`
        : requireText(options.description, 'A reversal description cannot be empty');
    const entry = this.#append({
      date,
      description,
      kind: 'reversal',
      reverses: id,
      lines: original.lines.map((line) =>
        Object.freeze({
          account: line.account,
          amount: -line.amount,
          ...(line.memo !== undefined ? { memo: line.memo } : {}),
        }),
      ),
    });
    this.#reversedBy.set(id, entry.id);
    this.#events.push({ type: 'reverse', id, date, description });
    return entry;
  }

  /**
   * Closes the books through `through`: moves the balance of every revenue and expense account
   * into `retainedEarnings` with a closing entry dated `through`, then locks every day up to and
   * including it. Later postings into the closed period fail with PERIOD_LOCKED.
   */
  closePeriod(options: { through: string; retainedEarnings: string }): CloseResult {
    const through = assertDate(options?.through, 'through');
    if (this.#lockedThrough !== undefined && through <= this.#lockedThrough) {
      throw new LedgerError(
        'PERIOD_LOCKED',
        `The books are already closed through ${this.#lockedThrough}`,
      );
    }
    const retained = this.#chart.get(options.retainedEarnings);
    if (retained.type !== 'equity') {
      throw new LedgerError('INVALID_ACCOUNT', `${retained.code} is not an equity account`);
    }
    if (!this.#chart.isLeaf(retained.code)) {
      throw new LedgerError('NOT_POSTABLE', `${retained.code} has sub-accounts`);
    }

    const balances = this.balances({ to: through });
    const lines: Line[] = [];
    let total = 0n;
    for (const account of this.#chart.list()) {
      if (account.type !== 'revenue' && account.type !== 'expense') continue;
      const balance = balances.get(account.code) ?? 0n;
      if (balance === 0n) continue;
      lines.push(Object.freeze({ account: account.code, amount: -balance }));
      total += balance;
    }
    if (total !== 0n) lines.push(Object.freeze({ account: retained.code, amount: total }));

    const entry =
      lines.length > 0
        ? this.#append({
            date: through,
            description: `Close the books through ${through}`,
            kind: 'closing',
            lines,
          })
        : undefined;
    this.#lockedThrough = through;
    this.#events.push({ type: 'close', through, retainedEarnings: retained.code });
    return Object.freeze({ entry, netIncome: -total });
  }

  /** Balance of every account that has postings, in minor units, positive for debit balances. */
  balances(query: BalanceQuery = {}): Map<string, bigint> {
    const from = query.from === undefined ? undefined : assertDate(query.from, 'from');
    const to = query.to === undefined ? undefined : assertDate(query.to, 'to');
    const result = new Map<string, bigint>();
    for (const entry of this.#entries) {
      if (from !== undefined && entry.date < from) continue;
      if (to !== undefined && entry.date > to) continue;
      if (query.excludeClosing && entry.kind === 'closing') continue;
      for (const line of entry.lines) {
        result.set(line.account, (result.get(line.account) ?? 0n) + line.amount);
      }
    }
    return result;
  }

  /**
   * Balance of one account including its sub-accounts, positive for debits. Use the account's
   * `normal` side to present it: a liability of -500n is a 5.00 credit balance.
   */
  balance(code: string, query: BalanceQuery = {}): bigint {
    const codes = new Set([code, ...this.#chart.descendants(code).map((a) => a.code)]);
    let total = 0n;
    for (const [account, amount] of this.balances(query)) {
      if (codes.has(account)) total += amount;
    }
    return total;
  }

  /** Parses an amount in this ledger's currency into minor units. */
  parse(amount: AmountInput): bigint {
    return parseAmount(amount, this.decimals);
  }

  /** Formats minor units in this ledger's currency: "1234.50". */
  format(amount: bigint): string {
    return formatAmount(amount, this.decimals);
  }

  toJSON(): LedgerSnapshot {
    return {
      format: 'ledger-core/v1',
      currency: this.currency,
      decimals: this.decimals,
      events: structuredClone(this.#events),
    };
  }

  /** Rebuilds a ledger by replaying a snapshot. Every rule is checked again on the way. */
  static fromJSON(snapshot: LedgerSnapshot): Ledger {
    if (snapshot?.format !== 'ledger-core/v1' || !Array.isArray(snapshot.events)) {
      throw new LedgerError('INVALID_SNAPSHOT', 'Not a ledger-core/v1 snapshot');
    }
    const ledger = new Ledger({ currency: snapshot.currency, decimals: snapshot.decimals });
    snapshot.events.forEach((event, index) => {
      try {
        switch (event.type) {
          case 'account':
            ledger.addAccount(event.account);
            break;
          case 'post':
            ledger.post(event);
            break;
          case 'reverse':
            ledger.reverse(event.id, { date: event.date, description: event.description });
            break;
          case 'close':
            ledger.closePeriod(event);
            break;
          default:
            throw new LedgerError('INVALID_SNAPSHOT', `Unknown event type`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new LedgerError('INVALID_SNAPSHOT', `Event ${index} cannot be replayed: ${reason}`, {
          cause: error,
        });
      }
    });
    return ledger;
  }

  #normalizeLines(lines: readonly LineInput[]): Line[] {
    if (!Array.isArray(lines) || lines.length < 2) {
      throw new LedgerError('INVALID_ENTRY', 'An entry needs at least two lines');
    }
    const normalized = lines.map((line, index) => {
      const label = `Line ${index + 1}`;
      const account = this.#chart.find(line?.account);
      if (!account) {
        throw new LedgerError(
          'UNKNOWN_ACCOUNT',
          `${label}: account ${line?.account} does not exist`,
        );
      }
      if (!this.#chart.isLeaf(account.code)) {
        throw new LedgerError(
          'NOT_POSTABLE',
          `${label}: ${account.code} has sub-accounts; post to one of them`,
        );
      }
      const hasDebit = line.debit !== undefined;
      const hasCredit = line.credit !== undefined;
      if (hasDebit === hasCredit) {
        throw new LedgerError('INVALID_ENTRY', `${label}: set exactly one of debit or credit`);
      }
      const value = parseAmount(
        (hasDebit ? line.debit : line.credit) as AmountInput,
        this.decimals,
      );
      if (value <= 0n) {
        throw new LedgerError('INVALID_AMOUNT', `${label}: the amount must be greater than zero`);
      }
      if (line.memo !== undefined && typeof line.memo !== 'string') {
        throw new LedgerError('INVALID_ENTRY', `${label}: memo must be a string`);
      }
      return Object.freeze({
        account: account.code,
        amount: hasDebit ? value : -value,
        ...(line.memo ? { memo: line.memo } : {}),
      });
    });
    const difference = normalized.reduce((sum, line) => sum + line.amount, 0n);
    if (difference !== 0n) {
      const side = difference > 0n ? 'debits exceed credits' : 'credits exceed debits';
      throw new LedgerError(
        'UNBALANCED',
        `The entry does not balance: ${side} by ${this.format(difference < 0n ? -difference : difference)}`,
      );
    }
    return normalized;
  }

  #append(draft: Omit<Entry, 'id' | 'seq'>): Entry {
    const seq = this.#entries.length + 1;
    const entry: Entry = Object.freeze({
      id: `JE-${String(seq).padStart(6, '0')}`,
      seq,
      ...draft,
      lines: Object.freeze([...draft.lines]),
    });
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
    for (const line of entry.lines) this.#postedAccounts.add(line.account);
    return entry;
  }

  #assertOpen(date: string): void {
    if (this.#lockedThrough !== undefined && date <= this.#lockedThrough) {
      throw new LedgerError(
        'PERIOD_LOCKED',
        `${date} is in a closed period (closed through ${this.#lockedThrough})`,
      );
    }
  }

  #serializeLine(line: Line): SerializedLine {
    const amount = this.format(line.amount < 0n ? -line.amount : line.amount);
    return {
      account: line.account,
      ...(line.amount > 0n ? { debit: amount } : { credit: amount }),
      ...(line.memo !== undefined ? { memo: line.memo } : {}),
    };
  }
}

function requireText(value: unknown, message: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new LedgerError('INVALID_ENTRY', message);
  return text;
}

function fingerprintOf(date: string, description: string, lines: readonly Line[]): string {
  return JSON.stringify([
    date,
    description,
    lines.map((line) => [line.account, line.amount.toString(), line.memo ?? null]),
  ]);
}

function toAccountInput(account: Account): AccountInput {
  return {
    code: account.code,
    name: account.name,
    type: account.type,
    ...(account.parent !== undefined ? { parent: account.parent } : {}),
    ...(account.contra ? { contra: true } : {}),
  };
}
