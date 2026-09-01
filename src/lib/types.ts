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
  /** The book's own account rather than one of yours — the one every debt
   *  runs through. Not shown among your accounts, and not editable. */
  system: boolean;
  /** Credit limit for a card, in paise. Zero means it isn't tracked. */
  creditLimit: Paise;
  /** The day of the month a card's statement closes, 1–31; 0 means the cycle
   *  isn't tracked and the card reads by calendar month. */
  statementDay: number;
  /** The day the bill has to be paid by, counted from the statement: the
   *  first such day after the cycle closed. 0 means it isn't tracked. */
  dueDay: number;
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
  /** Both only mean anything on a card; 0 on either leaves it untracked. */
  statementDay?: number;
  dueDay?: number;
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
  /** Labels pinned on top — "Triage" on unverified imports, say. */
  labels: TxLabel[];
  /**
   * The posting this one gives back, when it is a refund. A refund undoes
   * what it names rather than being money of its own: the two cancel, and
   * neither counts as earned or spent. The money still moved, so both still
   * count toward the balance.
   */
  refundOf: string | null;
  /** Who that posting was with, and what it was for. */
  refundOfMerchant: string | null;
  refundOfAmount: Paise | null;
  /** How much of *this* posting has been given back. Zero on nearly all. */
  refunded: Paise;
}

/** A label as it sits on a posting. */
export interface TxLabel {
  id: string;
  name: string;
  color: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  /** How many postings carry it right now. */
  count: number;
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
  /** Labels this posting should wear. Left off, nothing changes; a list
   *  replaces the set outright, empty taking them all off. */
  labelIds?: string[] | null;
  /** The posting this one refunds. Null on every save that isn't one, which
   *  is how a refund is taken off again. */
  refundOf?: string | null;
}

/* ------------------------------------------------------------------ cards */

/**
 * One billing cycle of a card. The one still running is `open`, and its
 * `closedOn` is the day the statement will be cut.
 */
export interface CardCycle {
  from: string;
  closedOn: string;
  /**
   * Charges less credits — the bank's arithmetic, not the book's: a refund
   * counts in the cycle it landed in, because that is where the bank put it.
   */
  spend: Paise;
  paid: Paise;
  open: boolean;
}

/** One card, and everything the tab says about it. */
export interface CardStat {
  id: string;
  name: string;
  institution: string | null;
  color: string;
  icon: string;
  /** Owed right now; zero on a card sitting in credit. */
  outstanding: Paise;
  /** The ledger's own figure: negative while anything is owed. */
  balance: Paise;
  creditLimit: Paise;
  /** Limit less outstanding. Zero when no limit is set. */
  available: Paise;
  statementDay: number;
  dueDay: number;
  /** Null on a card whose cycle isn't tracked. */
  statementOn: string | null;
  dueOn: string | null;
  statementTotal: Paise;
  /** What is left of the bill, and what has been spent since it was cut.
   *  The two always add up to `outstanding`. */
  billed: Paise;
  unbilled: Paise;
  paidSince: Paise;
  /** Spending over the window on screen, refunds netted off as everywhere
   *  else in the book, and the same figure for the window before it. */
  spend: Paise;
  prevSpend: Paise;
  paid: Paise;
  charges: number;
  lastUsed: string | null;
  /** The last dozen cycles, oldest first, the open one last. */
  cycles: CardCycle[];
  topCategories: CategorySlice[];
  topMerchants: MerchantSlice[];
}

export interface CardsOverview {
  month: string;
  span: number;
  outstanding: Paise;
  creditLimit: Paise;
  available: Paise;
  billed: Paise;
  unbilled: Paise;
  spend: Paise;
  prevSpend: Paise;
  paid: Paise;
  /**
   * Every card together, month by month: spent against paid off. Calendar
   * months rather than cycles, because two cards close on different days and
   * only the calendar is common to both.
   */
  monthly: FlowPoint[];
  cards: CardStat[];
}

/* -------------------------------------------------------------- templates */

/**
 * A transaction worth writing more than once, kept by name: the rent, the
 * Friday groceries, the standing transfer into savings. It holds the shape of
 * a posting rather than a posting — no date, because the date is the one
 * thing that is never the same twice.
 *
 * It holds what was on the form when it was kept, blanks included: a field
 * left empty is empty in the template, and empty again every time it is used.
 */
export interface TxTemplate {
  id: string;
  name: string;
  kind: TxKind;
  /** Zero means it was left blank, and the sheet opens on an empty well. */
  amount: Paise;
  /** Nullable where a posting's is not: an account can be deleted out from
   *  under a template, and the template is still worth keeping. */
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string;
  note: string | null;
  /** How many postings have been written from it, and when the last was. */
  usedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  accountName: string | null;
  accountColor: string | null;
  toAccountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  /** The parts a templated bill is filed under; they add up to `amount`. */
  splits: TemplateSplit[];
  /** Labels every posting written from it should wear. */
  labels: TxLabel[];
}

/** One line of a templated split bill. */
export interface TemplateSplit {
  id: string;
  templateId: string;
  amount: Paise;
  categoryId: string | null;
  note: string | null;
  sortOrder: number;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
}

export interface TxTemplateInput {
  id?: string | null;
  name: string;
  kind: TxKind;
  /** Zero for a template that does not carry an amount. */
  amount: Paise;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string;
  note: string | null;
  /** A template is written whole every time, so unlike a posting there is
   *  nothing half-saved to leave alone: what is sent is what it becomes. */
  splits?: TransactionSplitInput[] | null;
  labelIds?: string[] | null;
}

export interface LabelInput {
  id?: string | null;
  name: string;
  color: string;
}

/**
 * A change applied to a run of postings at once. Anything left off is left
 * alone; the two `clear` flags say "empty it" as against "don't touch it".
 */
export interface TransactionPatch {
  categoryId?: string | null;
  clearCategory?: boolean;
  accountId?: string | null;
  merchant?: string | null;
  note?: string | null;
  clearNote?: boolean;
}

/** What a bulk edit came to: changed, and left alone because it didn't apply. */
export interface BulkResult {
  changed: number;
  skipped: number;
}

export interface TransactionQuery {
  search?: string | null;
  /** Only postings carrying one of these labels. */
  labelIds?: string[] | null;
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
  /** The account the money moved through, for a posting this repayment
   *  wrote itself. Null when it linked one of yours, or posted nothing. */
  cashAccountId: string | null;
  createdAt: string;
}

export interface DebtPaymentInput {
  id?: string | null;
  debtId: string;
  amount: Paise;
  occurredAt: string;
  note: string | null;
  transactionId: string | null;
  /** Set it and the repayment posts a transfer — into this account for money
   *  coming back to you, out of it for money going to them. Exclusive with
   *  `transactionId`; leave both empty and nothing is written. */
  cashAccountId?: string | null;
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

/** What a holding is. The two deposits are valued by what they earn; the
 *  other two by what a market says they would fetch. */
export type HoldingKind = 'gold' | 'fund' | 'fd' | 'rd';

/** The tabs the Investments screen is divided into — deposits share one. */
export type InvestmentTab = 'fund' | 'gold' | 'deposit';

export const isDeposit = (kind: HoldingKind) => kind === 'fd' || kind === 'rd';
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
  /**
   * The day gold came into your hands, when it is known — what the value
   * line counts it from. Null for a fund, which is dated by its lots.
   */
  acquiredOn: string | null;
  /** A deposit's annual rate, scaled by 10^4: 7.25% is 72500. */
  rateE4: Scaled | null;
  /** The day a deposit started earning, and the day it comes back. */
  openedOn: string | null;
  maturesOn: string | null;
  /** What a deposit will be worth the day it matures. Zero for everything
   *  else, and for a deposit with no maturity date to reach. */
  maturityValue: Paise;
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
  /** The day it was acquired, YYYY-MM-DD. Optional — plenty of gold has been
   *  in the family longer than anyone remembers. */
  acquiredOn: string | null;
  /** A deposit's terms: the annual rate scaled by 10^4, and its two dates. */
  rateE4?: Scaled | null;
  openedOn?: string | null;
  maturesOn?: string | null;
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

/* ------------------------------------------------------- statement import */

export type StatementDirection = 'debit' | 'credit';

/** One line of a bank statement, as parsed. */
export interface StatementRow {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  narration: string;
  refNo: string;
  amount: Paise;
  /** debit = money left the account · credit = money arrived. */
  direction: StatementDirection;
  balance: Paise | null;
}

/** A statement row held against the book: already in it, or new with a guess. */
export interface ImportPreviewRow {
  row: StatementRow;
  status: 'new' | 'matched';
  matchedId: string | null;
  /** What the matched posting says of itself — merchant and category. */
  matchedSummary: string | null;
  /** The day the book's copy sits on — interesting when it differs. */
  matchedOn: string | null;
  kind: TxKind;
  categoryId: string | null;
  /** The other account, when the suggestion is a transfer. */
  transferAccountId: string | null;
  merchant: string;
  /** The suggestion came from a remembered rule; confirmed means a person
   *  verified that rule rather than the seeder guessing it. */
  fromRule: boolean;
  ruleConfirmed: boolean;
  /** Rows sharing this key are the same counterparty. */
  matchKey: string | null;
}

/** One row the user agreed to bring in: the statement's line, and the full
 *  posting it should become — whatever the transaction sheet wrote, splits,
 *  shares and all. */
export interface ImportCommitRow {
  row: StatementRow;
  input: TransactionInput;
  /** Arrives wearing the Triage label, to be verified by hand. */
  triage: boolean;
  /** A person shaped this filing in the review — teach the rule right away,
   *  the way confirming in triage would. */
  learn: boolean;
  /** Whether this row should move the balances it touches. False for money
   *  the current balance has already seen: it is recorded, and the opening
   *  balances it touches absorb it so nothing moves. */
  affectsBalance: boolean;
}

export interface ImportResult {
  inserted: number;
  triaged: number;
  /** How many inserted rows were recorded without moving a balance. */
  balanceNeutral: number;
  /** How many debts were opened alongside their postings. */
  debts: number;
  /** What the account's opening balance absorbed so the current balance
   *  stayed put while that history went in. */
  openingAdjustment: Paise;
}

/* -------------------------------------------------------- planned payments */

/** The rhythms a plan can keep. */
export type PlanCadence =
  | 'weekly'
  | 'fortnightly'
  | 'monthly'
  | 'quarterly'
  | 'half_yearly'
  | 'yearly';

/** Where a plan stands right now. */
export type PlanStatus =
  | 'upcoming'
  | 'due'
  | 'overdue'
  /** Was being paid, then stopped: three cycles with nothing against it. */
  | 'lapsed'
  | 'ended'
  | 'archived';

/** One posting a plan has collected, for the little history a card shows. */
export interface PlanPosting {
  id: string;
  occurredAt: string;
  amount: Paise;
}

/**
 * A payment that comes round again: rent, an EMI, a subscription, a salary.
 *
 * Everything from `nextDue` down is read off the ledger rather than stored,
 * so a plan can never disagree with the postings that answer to it.
 */
export interface Plan {
  id: string;
  name: string;
  kind: TxKind;
  /**
   * What it comes to. This is the figure the plan is for — not an average of
   * what has been paid before, which is history rather than what falls due
   * next.
   */
  amount: Paise;
  accountId: string | null;
  accountName: string | null;
  accountColor: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  merchant: string;
  note: string | null;
  cadence: PlanCadence;
  /** Every *n* of those. 1 for the ordinary case. */
  every: number;
  /**
   * A date the cycle lands on. Every other due date is counted from it, in
   * both directions — which is how a plan adopted today arrives carrying the
   * payments already behind it.
   */
  anchorOn: string;
  endsOn: string | null;
  archived: boolean;
  createdAt: string;

  /** The next cycle nobody has paid. Null once the plan has run out. */
  nextDue: string | null;
  /** Days from today; negative when it is already past. */
  daysUntil: number | null;
  status: PlanStatus;
  /** Cycles gone by with nothing paid against them. */
  missed: number;
  lastPaidOn: string | null;
  lastAmount: Paise;
  /** The mean of what it has lately actually cost. */
  averageAmount: Paise;
  paidCount: number;
  observedTotal: Paise;
  /** What it comes to a month, and a year, whatever its cadence. */
  monthlyAmount: Paise;
  yearlyAmount: Paise;
  /** The last payment against the expected amount; positive is a rise. */
  drift: Paise;
  /** The last few payments, oldest first. */
  recent: PlanPosting[];
}

export interface PlanInput {
  id?: string | null;
  name: string;
  kind: TxKind;
  amount: Paise;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  merchant: string;
  note: string | null;
  cadence: PlanCadence;
  every?: number | null;
  anchorOn: string;
  endsOn: string | null;
  archived?: boolean | null;
}

/** One turn of one plan, on the day it falls. What a calendar is made of. */
export interface PlanOccurrence {
  planId: string;
  name: string;
  kind: TxKind;
  dueOn: string;
  amount: Paise;
  merchant: string;
  categoryIcon: string | null;
  categoryColor: string | null;
  accountName: string | null;
  /** Whether a posting in the book answers for this cycle. */
  paid: boolean;
  transactionId: string | null;
  actualAmount: Paise;
  /** Deliberately let go rather than paid. */
  skipped: boolean;
}

// ------------------------------------------------------------------ tax

/** One line of working behind a head: a category it came from, or a
 *  counterparty who paid it. */
export interface TaxSlice {
  id: string;
  label: string;
  icon: string | null;
  color: string | null;
  total: Paise;
  count: number;
}

/** Everything filed under one tax tag for the year. An empty `tag` is the
 *  pile that has not been filed at all. */
export interface TaxHead {
  tag: string;
  total: Paise;
  count: number;
  prevTotal: Paise;
  categories: TaxSlice[];
  sources: TaxSlice[];
  /** Twelve figures, April first. */
  monthly: Paise[];
}

/** An advance-tax instalment date and the income that had landed by it. The
 *  instalment itself is a share of a liability Midas will not guess. */
export interface TaxQuarter {
  label: string;
  dueOn: string;
  /** The statutory cumulative share: 15, 45, 75, 100. */
  share: number;
  income: Paise;
  past: boolean;
}

export interface TaxYear {
  /** The calendar year the financial year opens in: 2025 is FY 2025-26. */
  fy: number;
  label: string;
  assessment: string;
  startsOn: string;
  endsOn: string;
  closed: boolean;
  income: Paise;
  prevIncome: Paise;
  classified: Paise;
  unclassified: Paise;
  unclassifiedCount: number;
  heads: TaxHead[];
  deductions: TaxHead[];
  quarters: TaxQuarter[];
  interest: TaxSlice[];
  unfiled: Transaction[];
  untaggedCategories: number;
}
