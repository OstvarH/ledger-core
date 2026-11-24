/** Every failure the ledger reports carries one of these codes, so callers can branch on it. */
export type LedgerErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_DATE'
  | 'INVALID_CURRENCY'
  | 'INVALID_ACCOUNT'
  | 'DUPLICATE_ACCOUNT'
  | 'UNKNOWN_ACCOUNT'
  | 'NOT_POSTABLE'
  | 'INVALID_ENTRY'
  | 'UNBALANCED'
  | 'PERIOD_LOCKED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNKNOWN_ENTRY'
  | 'ALREADY_REVERSED'
  | 'INVALID_SNAPSHOT';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LedgerError';
    this.code = code;
  }
}
