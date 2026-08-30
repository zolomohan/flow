export type TxKind = 'income' | 'expense' | 'transfer';
export type AccountKind = 'bank' | 'credit' | 'cash' | 'wallet' | 'investment';
export type CategoryKind = 'income' | 'expense';

/** Every amount crossing the Rust boundary is an integer count of paise. */
export type Paise = number;

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  openingBalance: Paise;
  color: string;
  icon: string;
  archived: boolean;
  sortOrder: number;
  createdAt: string;
  balance: Paise;
  /**
   * What the holdings parked in this account are worth today, less the basis
   * their own postings already put on `balance`. Zero unless a holding sits
   * here — and the whole of a holding whose entries posted nothing, which the
   * ledger knows nothing about. Use `accountWorth` rather than adding it by
   * hand.
   */
  revaluation: Paise;
  /** Credit limit for a card, in paise. Zero means it isn't tracked. */
  creditLimit: Paise;
}

export interface AccountInput {
  id?: string | null;
  name: string;
  kind: AccountKind;
  institution: string | null;
  openingBalance: Paise;
  color: string;
  icon: string;
  creditLimit: Paise;
}

export interface Category {
  id: string;
  kind: CategoryKind;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  /** null for a top-level group. Nesting is exactly one level deep. */
  parentId: string | null;
}

/** What happens to a category's transactions and children when it is deleted. */
export interface CategoryDeleteOptions {
  /** Category to file the transactions under; null leaves them uncategorised. */
  reassignTo?: string | null;
  /** Delete the sub-categories too, rather than promoting them. */
  deleteChildren?: boolean;
}

export interface CategoryInput {
  id?: string | null;
  kind: CategoryKind;
  name: string;
  icon: string;
  color: string;
  parentId: string | null;
}

export interface Transaction {
  id: string;
  kind: TxKind;
  amount: Paise;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string;
  note: string | null;
  occurredAt: string;
  createdAt: string;
  accountName: string;
  accountColor: string;
  toAccountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  /** The top-level group this transaction's category rolls up into. */
  categoryGroupId: string | null;
  categoryGroupName: string | null;
  /**
   * The line items this bill was split into. Empty for the ordinary case —
   * one bill, one category. When it isn't, the parts add up to `amount`
   * exactly, so the ledger still sees a single posting.
   */
  splits: TransactionSplit[];
  /** Who else was in on this bill. Each share is a debt of its own. */
  shares: TransactionShare[];
}

/** One line of a split bill: part of the money, filed on its own. */
export interface TransactionSplit {
  id: string;
  transactionId: string;
  amount: Paise;
  categoryId: string | null;
  note: string | null;
  sortOrder: number;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  categoryGroupId: string | null;
  categoryGroupName: string | null;
}

export interface TransactionSplitInput {
  id?: string | null;
  amount: Paise;
  categoryId: string | null;
  note: string | null;
}

/** One person's share of a split bill, seen from the posting that opened it. */
export interface TransactionShare {
  debtId: string;
  direction: DebtDirection;
  counterparty: string;
  amount: Paise;
  dueOn: string | null;
  note: string | null;
  paid: Paise;
  outstanding: Paise;
  settled: boolean;
}

export interface TransactionShareInput {
  /** The debt this share already is, when the split is being edited. */
  id?: string | null;
  direction: DebtDirection;
  counterparty: string;
  amount: Paise;
  dueOn: string | null;
  note: string | null;
}

export interface TransactionInput {
  id?: string | null;
  kind: TxKind;
  amount: Paise;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string;
  note: string | null;
  occurredAt: string;
  /**
   * Line items to file this posting under. Leave it off and whatever is
   * already there is untouched; an empty list clears the split.
   */
  splits?: TransactionSplitInput[] | null;
  /** Who owes what out of this bill. Same rule as `splits`. */
  shares?: TransactionShareInput[] | null;
}

export interface TransactionQuery {
  search?: string | null;
  kinds?: TxKind[] | null;
  accountIds?: string[] | null;
  /** Which side of a posting the accounts must be on. Only transfers differ. */
  accountSide?: 'either' | 'from' | 'to' | null;
  categoryIds?: string[] | null;
  from?: string | null;
  to?: string | null;
  limit?: number | null;
  /** Rows to skip, for paging a long ledger. */
  offset?: number | null;
}

/** What a filtered ledger comes to, whatever slice of it is on screen. */
export interface TransactionSummary {
  count: number;
  income: Paise;
  expense: Paise;
  transferred: Paise;
}

export interface CategorySlice {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
  total: Paise;
  count: number;
  /** Leaf categories rolled into this group, largest first. */
  children: CategorySlice[];
}

export interface FlowPoint {
  bucket: string;
  income: Paise;
  expense: Paise;
}

export interface MerchantSlice {
  merchant: string;
  total: Paise;
  count: number;
}

export interface Overview {
  /** Last month of the window, as YYYY-MM. */
  month: string;
  /** How many months the window covers, counting back from `month`. */
  span: number;
  /** Accounts plus what you are owed, minus what you owe. */
  netWorth: Paise;
  liquid: Paise;
  /** Negative account balances plus borrowed debt. */
  debt: Paise;
  lentOutstanding: Paise;
  borrowedOutstanding: Paise;
  /** What the holdings on the Investments screen are worth today. */
  investments: Paise;
  income: Paise;
  expense: Paise;
  prevIncome: Paise;
  prevExpense: Paise;
  balanceSeries: Paise[];
  dailyFlow: FlowPoint[];
  monthlyFlow: FlowPoint[];
  topCategories: CategorySlice[];
  topMerchants: MerchantSlice[];
}

/* ------------------------------------------------------------------ debts */

export type DebtDirection = 'lent' | 'borrowed';

export interface DebtPayment {
  id: string;
  debtId: string;
  amount: Paise;
  occurredAt: string;
  note: string | null;
  transactionId: string | null;
  transactionLabel: string | null;
  createdAt: string;
}

export interface DebtPaymentInput {
  id?: string | null;
  debtId: string;
  amount: Paise;
  occurredAt: string;
  note: string | null;
  transactionId: string | null;
}

export interface Debt {
  id: string;
  /** lent = they owe you · borrowed = you owe them */
  direction: DebtDirection;
  counterparty: string;
  principal: Paise;
  openedOn: string;
  dueOn: string | null;
  note: string | null;
  settledAt: string | null;
  createdAt: string;
  transactionId: string | null;
  transactionLabel: string | null;
  /** True when this debt is one person's share of a split bill. */
  fromSplit: boolean;
  paid: Paise;
  outstanding: Paise;
  settled: boolean;
  payments: DebtPayment[];
}

export interface DebtInput {
  id?: string | null;
  direction: DebtDirection;
  counterparty: string;
  principal: Paise;
  openedOn: string;
  dueOn: string | null;
  note: string | null;
  transactionId: string | null;
  settled?: boolean | null;
}

/* ------------------------------------------------------------ investments */

export type HoldingKind = 'gold' | 'fund';
export type LotKind = 'buy' | 'sell';

/**
 * Grams, units and per-unit prices cross the wire as integers scaled by 10^4,
 * for the same reason money crosses as paise: so nothing is ever a float.
 */
export type Scaled = number;

export interface InvestmentLot {
  id: string;
  holdingId: string;
  kind: LotKind;
  quantityE4: Scaled;
  amount: Paise;
  /** When the money moved — the date the ledger posting carries. */
  occurredAt: string;
  /** When the units were credited, when that was another day. Null means the
   *  units landed the day the money moved. */
  allottedAt: string | null;
  transactionId: string | null;
  transactionLabel: string | null;
  /** Where the money came from on a buy, or went to on a sale. */
  cashAccountId: string | null;
  /** Whether the lot wrote that posting itself, or you linked one of yours. */
  ownsTransaction: boolean;
  note: string | null;
  createdAt: string;
}

export interface InvestmentLotInput {
  id?: string | null;
  holdingId: string;
  kind: LotKind;
  quantityE4: Scaled;
  amount: Paise;
  /** When the money moved. */
  occurredAt: string;
  /** When the units were credited, if that was another day — an SIP is
   *  debited on one date and allotted at another day's NAV. */
  allottedAt: string | null;
  note: string | null;
  /** Set it and the lot posts a transfer; leave it null and nothing moves. */
  cashAccountId: string | null;
  /** A posting already in your book that this lot describes. Exclusive with
   *  `cashAccountId`: the lot either writes a transfer or points at one. */
  transactionId: string | null;
}

export interface Holding {
  id: string;
  kind: HoldingKind;
  name: string;
  accountId: string | null;
  accountName: string | null;
  schemeCode: string | null;
  isin: string | null;
  /** 10000 is 24K, 9160 is 22K, 7500 is 18K. */
  purityE4: Scaled | null;
  note: string | null;
  closedAt: string | null;
  createdAt: string;
  /** Grams for gold, units for a fund. */
  unitsE4: Scaled;
  /** Both are zero for gold: an object you own, not a position you traded. */
  invested: Paise;
  realised: Paise;
  /** Rupees per gram or unit, scaled. null until a price has been fetched. */
  priceE4: Scaled | null;
  priceAsOf: string | null;
  marketValue: Paise;
  totalReturn: Paise;
  closed: boolean;
  lots: InvestmentLot[];
}

export interface HoldingInput {
  id?: string | null;
  kind: HoldingKind;
  name: string;
  accountId: string | null;
  schemeCode: string | null;
  isin: string | null;
  purityE4: Scaled | null;
  /** Grams of gold held, scaled. Gold is weighed, not traded, so this is the
   *  whole of the position; a fund ignores it and counts its lots instead. */
  gramsE4: Scaled | null;
  note: string | null;
  closed?: boolean | null;
}

/**
 * One day on a price line: rupees per gram or per unit, scaled by 10^4, on
 * the date that price was published. Points arrive oldest first.
 */
export interface PricePoint {
  asOf: string;
  priceE4: Scaled;
}

/**
 * One day on a value line: what something was worth, in paise. A price line
 * says what a gram went for; this says what the pile of them came to — and
 * it is what the charts actually plot, prices mapped onto it.
 */
export interface ValuePoint {
  asOf: string;
  value: Paise;
}

export interface Scheme {
  schemeCode: string;
  schemeName: string;
}
