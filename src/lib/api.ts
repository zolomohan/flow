import { invoke } from '@tauri-apps/api/core';
import type {
  Account,
  AccountInput,
  Category,
  CategoryInput,
  Holding,
  HoldingInput,
  InvestmentLotInput,
  Scheme,
  Debt,
  DebtInput,
  DebtPaymentInput,
  Overview,
  PricePoint,
  ValuePoint,
  BulkResult,
  Transaction,
  TransactionInput,
  TransactionPatch,
  TransactionQuery,
  TransactionSummary,
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
  saveTransaction: (input: TransactionInput) =>
    call<Transaction>('save_transaction', { input }),
  deleteTransaction: (id: string) => call<void>('delete_transaction', { id }),
  updateTransactions: (ids: string[], patch: TransactionPatch) =>
    call<BulkResult>('update_transactions', { ids, patch }),
  deleteTransactions: (ids: string[]) => call<number>('delete_transactions', { ids }),

  overview: (month: string, span = 1) => call<Overview>('overview', { month, span }),

  listDebts: () => call<Debt[]>('list_debts'),
  saveDebt: (input: DebtInput) => call<void>('save_debt', { input }),
  deleteDebt: (id: string) => call<void>('delete_debt', { id }),
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
  /** What the gold held has been worth, day by day. Null counts every piece. */
  goldValueSeries: (days: number | null, purityE4: number | null) =>
    call<ValuePoint[]>('gold_value_series', { days, purityE4 }),
  searchSchemes: (query: string) => call<Scheme[]>('search_schemes', { query }),

  getSetting: (key: string) => call<string | null>('get_setting', { key }),
  setSetting: (key: string, value: string) => call<void>('set_setting', { key, value }),

  seedDemo: () => call<void>('seed_demo'),
  resetAll: () => call<void>('reset_all'),
};
