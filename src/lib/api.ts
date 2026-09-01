import { invoke } from '@tauri-apps/api/core';
import type {
  Account,
  AccountInput,
  CardsOverview,
  Category,
  CategoryInput,
  Holding,
  HoldingInput,
  InvestmentLotInput,
  Scheme,
  Debt,
  DebtInput,
  DebtPaymentInput,
  ImportCommitRow,
  ImportPreviewRow,
  ImportResult,
  Label,
  LabelInput,
  Overview,
  Paise,
  PricePoint,
  StatementRow,
  ValuePoint,
  BulkResult,
  Transaction,
  TransactionInput,
  TransactionPatch,
  TransactionQuery,
  TaxYear,
  TransactionSummary,
  TxTemplate,
  TxTemplateInput,
  Plan,
  PlanInput,
  PlanOccurrence,
} from './types';

export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) {
    throw new Error(
      'Midas stores your book in a local SQLite file, so it needs the desktop shell. Run `yarn tauri dev`.',
    );
  }
  return invoke<T>(cmd, args);
}

export const api = {
  listAccounts: () => call<Account[]>('list_accounts'),
  saveAccount: (input: AccountInput) => call<Account>('save_account', { input }),
  setAccountArchived: (id: string, archived: boolean) =>
    call<void>('set_account_archived', { id, archived }),
  deleteAccount: (id: string) => call<void>('delete_account', { id }),
  reorderAccounts: (ids: string[]) => call<void>('reorder_accounts', { ids }),

  listCategories: () => call<Category[]>('list_categories'),
  saveCategory: (input: CategoryInput) => call<Category>('save_category', { input }),
  categoryUsage: () => call<Record<string, number>>('category_usage'),
  reassignCategory: (from: string, to: string, includeChildren: boolean) =>
    call<number>('reassign_category', { from, to, includeChildren }),
  deleteCategory: (id: string, reassignTo: string | null, deleteChildren: boolean) =>
    call<void>('delete_category', { id, reassignTo, deleteChildren }),

  listTransactions: (query?: TransactionQuery) =>
    call<Transaction[]>('list_transactions', { query: query ?? null }),
  transactionSummary: (query?: TransactionQuery) =>
    call<TransactionSummary>('transaction_summary', { query: query ?? null }),
  transaction: (id: string) => call<Transaction>('transaction', { id }),
  saveTransaction: (input: TransactionInput) =>
    call<Transaction>('save_transaction', { input }),
  deleteTransaction: (id: string) => call<void>('delete_transaction', { id }),
  updateTransactions: (ids: string[], patch: TransactionPatch) =>
    call<BulkResult>('update_transactions', { ids, patch }),
  deleteTransactions: (ids: string[]) => call<number>('delete_transactions', { ids }),

  overview: (month: string, span = 1) => call<Overview>('overview', { month, span }),

  /** Every credit card: what is owed, what is billed, what the window bought. */
  cards: (month: string, span = 1) => call<CardsOverview>('cards', { month, span }),

  /** A financial year of earnings, grouped by the head each is filed under.
   *  Computes no tax, on purpose. */
  taxYear: (fy: number) => call<TaxYear>('tax_year', { fy }),
  /** Which financial years the book has anything to say about. */
  taxYears: () => call<number[]>('tax_years'),
  /** Every category that has been given a tax head, as categoryId -> tag. */
  taxMap: () => call<Record<string, string>>('tax_map'),
  /** Files a category under a head; null puts it back on the undecided pile. */
  setTaxTag: (categoryId: string, tag: string | null) =>
    call<void>('set_tax_tag', { categoryId, tag }),
  /** The year as CSV, one row per posting, for whoever actually files it. */
  taxExport: (fy: number) => call<string>('tax_export', { fy }),

  /** Reads a bank statement file into rows. Touches nothing. */
  parseStatement: (path: string) => call<StatementRow[]>('parse_statement', { path }),
  /** Holds parsed rows against one account: matched, or new with a guess. */
  previewStatementImport: (accountId: string, rows: StatementRow[]) =>
    call<ImportPreviewRow[]>('preview_statement_import', { accountId, rows }),
  /** Posts the agreed rows, wearing the Triage label where asked. A row
   *  marked as not affecting the balance is absorbed by the openings it
   *  touches, so recording it moves nothing. */
  commitStatementImport: (accountId: string, rows: ImportCommitRow[]) =>
    call<ImportResult>('commit_statement_import', { accountId, rows }),
  listLabels: () => call<Label[]>('list_labels'),
  saveLabel: (input: LabelInput) => call<Label>('save_label', { input }),
  /** The label goes and comes off every posting; the postings stay. */
  deleteLabel: (id: string) => call<void>('delete_label', { id }),
  /** "Filed right": clears Triage and teaches the importer the filing. */
  confirmTriage: (ids: string[]) => call<number>('confirm_triage', { ids }),

  /** Every saved template, what you reach for most at the top. */
  listTemplates: () => call<TxTemplate[]>('list_templates'),
  /** Writes one whole: what it says, its parts, and the labels it pins. */
  saveTemplate: (input: TxTemplateInput) => call<TxTemplate>('save_template', { input }),
  /** The template goes; every posting written from it stays. */
  deleteTemplate: (id: string) => call<void>('delete_template', { id }),
  /** Counts one posting written from a template, so the list keeps what you
   *  actually reach for near the top. Called once the posting is saved. */
  useTemplate: (id: string) => call<void>('use_template', { id }),

  /** Every plan, with what the ledger says each is actually costing. */
  listPlans: () => call<Plan[]>('list_plans'),
  savePlan: (input: PlanInput) => call<Plan>('save_plan', { input }),
  deletePlan: (id: string) => call<void>('delete_plan', { id }),
  setPlanArchived: (id: string, archived: boolean) =>
    call<void>('set_plan_archived', { id, archived }),
  /** Lets the cycle now due go by unpaid — a waived bill, a month off. */
  skipPlan: (id: string) => call<Plan>('skip_plan', { id }),
  /** Writes the posting this cycle describes and points the plan at it. */
  payPlan: (id: string, amount: Paise | null, occurredAt: string | null) =>
    call<Transaction>('pay_plan', { id, amount, occurredAt }),
  /** Every turn of every live plan between two dates, paid ones included. */
  planCalendar: (from: string, to: string) =>
    call<PlanOccurrence[]>('plan_calendar', { from, to }),
  /** The whole life of one plan, oldest cycle first — paid, let go and
   *  missed alike. What a plan's own page is drawn from. */
  planTimeline: (id: string) => call<PlanOccurrence[]>('plan_timeline', { id }),
  /** Says these postings belong to this plan. Nothing counts for a plan
   *  until it does — a plan never claims a payment on its own. */
  linkPlanPostings: (planId: string, ids: string[]) =>
    call<number>('link_plan_postings', { planId, ids }),
  /** Takes a posting back off a plan. The posting itself is untouched. */
  unlinkPlanPosting: (planId: string, transactionId: string) =>
    call<void>('unlink_plan_posting', { planId, transactionId }),
  /** Which plan each of these postings already backs, by posting id. */
  plansOfPostings: (ids: string[]) =>
    call<Record<string, string>>('plans_of_postings', { ids }),

  listDebts: () => call<Debt[]>('list_debts'),
  saveDebt: (input: DebtInput) => call<void>('save_debt', { input }),
  deleteDebt: (id: string) => call<void>('delete_debt', { id }),
  /** The postings one debt is made of — linked, not guessed at by name. */
  debtEntries: (id: string) => call<Transaction[]>('debt_entries', { id }),
  saveDebtPayment: (input: DebtPaymentInput) =>
    call<void>('save_debt_payment', { input }),
  deleteDebtPayment: (id: string) => call<void>('delete_debt_payment', { id }),

  listHoldings: () => call<Holding[]>('list_holdings'),
  saveHolding: (input: HoldingInput) => call<void>('save_holding', { input }),
  deleteHolding: (id: string) => call<void>('delete_holding', { id }),
  saveInvestmentLot: (input: InvestmentLotInput) =>
    call<void>('save_investment_lot', { input }),
  deleteInvestmentLot: (id: string) => call<void>('delete_investment_lot', { id }),
  refreshPrices: () => call<void>('refresh_prices'),
  /** One holding's price line. `days` bounds the window; null asks for all. */
  holdingSeries: (id: string, days: number | null) =>
    call<PricePoint[]>('holding_series', { id, days }),
  /** Every holding's line at once, keyed by holding id. */
  holdingSeriesAll: (days: number | null) =>
    call<Record<string, PricePoint[]>>('holding_series_all', { days }),

  /** What one holding of yours has been worth, day by day: the units you held
   *  at each day's price, rather than the scheme's own NAV line. */
  holdingValueSeries: (id: string, days: number | null) =>
    call<ValuePoint[]>('holding_value_series', { id, days }),

  /** The same, for every holding at once. */
  holdingValueSeriesAll: (days: number | null) =>
    call<Record<string, ValuePoint[]>>('holding_value_series_all', { days }),
  /** What the gold held has been worth, day by day. Null counts every piece. */
  goldValueSeries: (days: number | null, purityE4: number | null) =>
    call<ValuePoint[]>('gold_value_series', { days, purityE4 }),

  /** What a gram of gold has gone for, day by day, at a fineness. Null reads
   *  it as 24K. A fact about the market, not about the pieces you hold. */
  goldRateSeries: (days: number | null, purityE4: number | null) =>
    call<PricePoint[]>('gold_rate_series', { days, purityE4 }),

  /** What everything held has been worth, day by day, as one line. */
  portfolioValueSeries: (days: number | null) =>
    call<ValuePoint[]>('portfolio_value_series', { days }),
  searchSchemes: (query: string) => call<Scheme[]>('search_schemes', { query }),

  getSetting: (key: string) => call<string | null>('get_setting', { key }),
  listSettings: () => call<Record<string, string>>('list_settings'),
  setSetting: (key: string, value: string) => call<void>('set_setting', { key, value }),

  /** Writes the whole book to a file. Resolves with where it went. */
  exportBook: (to: string) => call<string>('export_book', { to }),
  /** Reads one back over this book. Resolves with where the old one was kept. */
  importBook: (from: string) => call<string>('import_book', { from }),
  resetAll: () => call<void>('reset_all'),
};
