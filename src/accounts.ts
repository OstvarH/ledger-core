import { LedgerError } from './errors.ts';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type Side = 'debit' | 'credit';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

const NATURAL_SIDE: Record<AccountType, Side> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AccountInput {
  /** Unique, stable identifier such as "1000" or "4000-01". */
  code: string;
  name: string;
  type: AccountType;
  /** Code of the parent account. A sub-account must have the same type as its parent. */
  parent?: string;
  /**
   * A contra account carries the opposite balance of its type, for example accumulated
   * depreciation (an asset with a credit balance) or sales returns (revenue with a debit balance).
   */
  contra?: boolean;
}

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parent?: string;
  readonly contra: boolean;
  /** The side that increases this account: debit for assets and expenses, credit otherwise. */
  readonly normal: Side;
}

/**
 * A tree of accounts. Only leaf accounts take postings; parents exist to group and roll up
 * balances in reports.
 */
export class ChartOfAccounts {
  readonly #accounts = new Map<string, Account>();
  readonly #children = new Map<string, string[]>();

  add(input: AccountInput): Account {
    const { code, type, parent } = input ?? ({} as AccountInput);
    if (typeof code !== 'string' || !CODE.test(code)) {
      throw new LedgerError(
        'INVALID_ACCOUNT',
        `Account code must be letters, digits, ".", "_" or "-", got "${code}"`,
      );
    }
    if (this.#accounts.has(code)) {
      throw new LedgerError('DUPLICATE_ACCOUNT', `Account ${code} already exists`);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new LedgerError('INVALID_ACCOUNT', `Account ${code} needs a name`);
    if (!ACCOUNT_TYPES.includes(type)) {
      throw new LedgerError('INVALID_ACCOUNT', `Account ${code} has an unknown type "${type}"`);
    }
    if (parent !== undefined) {
      const parentAccount = this.#accounts.get(parent);
      if (!parentAccount) {
        throw new LedgerError(
          'UNKNOWN_ACCOUNT',
          `Parent account ${parent} of ${code} does not exist`,
        );
      }
      if (parentAccount.type !== type) {
        throw new LedgerError(
          'INVALID_ACCOUNT',
          `Account ${code} is ${type} but its parent ${parent} is ${parentAccount.type}`,
        );
      }
    }
    const contra = input.contra === true;
    const natural = NATURAL_SIDE[type];
    const account: Account = Object.freeze({
      code,
      name,
      type,
      ...(parent !== undefined ? { parent } : {}),
      contra,
      normal: contra ? opposite(natural) : natural,
    });
    this.#accounts.set(code, account);
    this.#children.set(code, []);
    if (parent !== undefined) this.#children.get(parent)?.push(code);
    return account;
  }

  has(code: string): boolean {
    return this.#accounts.has(code);
  }

  find(code: string): Account | undefined {
    return this.#accounts.get(code);
  }

  get(code: string): Account {
    const account = this.#accounts.get(code);
    if (!account) throw new LedgerError('UNKNOWN_ACCOUNT', `Account ${code} does not exist`);
    return account;
  }

  isLeaf(code: string): boolean {
    return (this.#children.get(this.get(code).code)?.length ?? 0) === 0;
  }

  /** Direct sub-accounts, sorted by code. */
  children(code: string): Account[] {
    return sortByCode((this.#children.get(this.get(code).code) ?? []).map((c) => this.get(c)));
  }

  /** All accounts below `code`, at any depth. */
  descendants(code: string): Account[] {
    const result: Account[] = [];
    const walk = (current: string) => {
      for (const child of this.children(current)) {
        result.push(child);
        walk(child.code);
      }
    };
    walk(code);
    return result;
  }

  /** Every account, sorted by code. */
  list(): Account[] {
    return sortByCode([...this.#accounts.values()]);
  }

  /** Top-level accounts, sorted by code. */
  roots(): Account[] {
    return this.list().filter((account) => account.parent === undefined);
  }

  get size(): number {
    return this.#accounts.size;
  }
}

/** The chart as the ledger exposes it: readable, but accounts are added through the ledger. */
export type ReadonlyChart = Omit<ChartOfAccounts, 'add'>;

function opposite(side: Side): Side {
  return side === 'debit' ? 'credit' : 'debit';
}

function sortByCode(accounts: Account[]): Account[] {
  return accounts.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
