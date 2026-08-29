import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { monthKey } from './format';
import type {
  Account,
  AccountInput,
  Category,
  CategoryDeleteOptions,
  CategoryInput,
  Debt,
  DebtInput,
  DebtPaymentInput,
  Holding,
  HoldingInput,
  InvestmentLotInput,
  Overview,
  Transaction,
  TransactionInput,
  TransactionQuery,
  TransactionSummary,
} from './types';

export interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
  /** Optional single-shot undo, wired up by whoever raised the toast. */
  undo?: () => void;
}

interface Store {
  ready: boolean;
  fatal: string | null;
  accounts: Account[];
  categories: Category[];
  /** Transactions filed under each category id; missing means none. */
  categoryUsage: Record<string, number>;
  debts: Debt[];
  holdings: Holding[];
  overview: Overview | null;
  /** Last month of the period in view. */
  month: string;
  setMonth: (m: string) => void;
  /** How many months that period covers — 1 for a month, 12 for a year. */
  span: number;
  setSpan: (n: number) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  toasts: Toast[];
  toast: (message: string, tone?: Toast['tone'], undo?: () => void) => void;
  dismissToast: (id: number) => void;
  saveAccount: (input: AccountInput) => Promise<Account>;
  deleteAccount: (id: string) => Promise<void>;
  setAccountArchived: (id: string, archived: boolean) => Promise<void>;
  saveCategory: (input: CategoryInput) => Promise<Category>;
  reassignCategory: (from: string, to: string, includeChildren: boolean) => Promise<number>;
  deleteCategory: (id: string, options?: CategoryDeleteOptions) => Promise<void>;
  saveDebt: (input: DebtInput) => Promise<void>;
  deleteDebt: (id: string) => Promise<void>;
  saveDebtPayment: (input: DebtPaymentInput) => Promise<void>;
  deleteDebtPayment: (id: string) => Promise<void>;
  saveHolding: (input: HoldingInput) => Promise<void>;
  deleteHolding: (id: string) => Promise<void>;
  saveLot: (input: InvestmentLotInput) => Promise<void>;
  deleteLot: (id: string) => Promise<void>;
  /** Fetches live prices. Resolves either way — failures land as a toast. */
  refreshPrices: () => Promise<void>;
  pricesRefreshing: boolean;
  saveTransaction: (input: TransactionInput) => Promise<Transaction>;
  deleteTransaction: (id: string) => Promise<void>;
  listTransactions: (query?: TransactionQuery) => Promise<Transaction[]>;
  transactionSummary: (query?: TransactionQuery) => Promise<TransactionSummary>;
  seedDemo: () => Promise<void>;
  resetAll: () => Promise<void>;
  /** Bumped after every write so screens can re-run their own queries. */
  revision: number;
}

const Ctx = createContext<Store | null>(null);

export function useStore() {
  const store = useContext(Ctx);
  if (!store) throw new Error('useStore must be used inside <StoreProvider>');
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryUsage, setCategoryUsage] = useState<Record<string, number>>({});
  const [debts, setDebts] = useState<Debt[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [pricesRefreshing, setPricesRefreshing] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [month, setMonth] = useState(monthKey());
  const [span, setSpan] = useState(1);
  const [revision, setRevision] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (localStorage.getItem('midas.theme') as 'light' | 'dark') ?? 'light',
  );
  const toastSeq = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('midas.theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: Toast['tone'] = 'ok', undo?: () => void) => {
      const id = ++toastSeq.current;
      setToasts((list) => [...list.slice(-2), { id, message, tone, undo }]);
      window.setTimeout(() => dismissToast(id), undo ? 6500 : 3200);
    },
    [dismissToast],
  );

  const refresh = useCallback(
    async (forMonth: string, forSpan: number) => {
      const [nextAccounts, nextCategories, nextUsage, nextDebts, nextHoldings, nextOverview] =
        await Promise.all([
          api.listAccounts(),
          api.listCategories(),
          api.categoryUsage(),
          api.listDebts(),
          api.listHoldings(),
          api.overview(forMonth, forSpan),
        ]);
      setAccounts(nextAccounts);
      setCategories(nextCategories);
      setCategoryUsage(nextUsage);
      setDebts(nextDebts);
      setHoldings(nextHoldings);
      setOverview(nextOverview);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refresh(month, span);
        if (!cancelled) {
          setFatal(null);
          setReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          setFatal(err instanceof Error ? err.message : String(err));
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, span, refresh, revision]);

  /** Runs a write, surfaces failures as a toast, and refreshes derived state. */
  const mutate = useCallback(
    async <T,>(run: () => Promise<T>, success?: string): Promise<T> => {
      try {
        const result = await run();
        setRevision((r) => r + 1);
        if (success) toast(success);
        return result;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        throw err;
      }
    },
    [toast],
  );

  // Fetching prices writes nothing of yours, so it sits outside `mutate`: a
  // failed refresh should say so once, not read like a failed save.
  const refreshPrices = useCallback(async () => {
    setPricesRefreshing(true);
    try {
      await api.refreshPrices();
      setRevision((r) => r + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPricesRefreshing(false);
    }
  }, [toast]);

  // Prices go stale overnight, so top them up once after the book loads. Doing
  // it here rather than inside the screen keeps the Overview's net worth right
  // even when the Investments screen is never opened.
  const primed = useRef(false);
  useEffect(() => {
    if (!ready || primed.current || !holdings.length) return;
    primed.current = true;
    const today = new Date().toISOString().slice(0, 10);
    if (holdings.some((h) => !h.priceAsOf || h.priceAsOf < today)) void refreshPrices();
  }, [ready, holdings, refreshPrices]);

  const value = useMemo<Store>(
    () => ({
      ready,
      fatal,
      accounts,
      categories,
      categoryUsage,
      debts,
      holdings,
      overview,
      month,
      setMonth,
      span,
      setSpan,
      theme,
      toggleTheme,
      toasts,
      toast,
      dismissToast,
      revision,
      saveAccount: (input) =>
        mutate(
          () => api.saveAccount(input),
          input.id ? 'Account updated' : 'Account added',
        ),
      deleteAccount: (id) =>
        mutate(() => api.deleteAccount(id), 'Account deleted'),
      setAccountArchived: (id, archived) =>
        mutate(
          () => api.setAccountArchived(id, archived),
          archived ? 'Account archived' : 'Account restored',
        ),
      saveCategory: (input) =>
        mutate(
          () => api.saveCategory(input),
          input.id ? 'Category updated' : 'Category added',
        ),
      reassignCategory: (from, to, includeChildren) =>
        mutate(() => api.reassignCategory(from, to, includeChildren), 'Transactions moved'),
      deleteCategory: (id, options) =>
        mutate(
          () =>
            api.deleteCategory(
              id,
              options?.reassignTo ?? null,
              options?.deleteChildren ?? false,
            ),
          'Category deleted',
        ),
      saveDebt: (input) =>
        mutate(() => api.saveDebt(input), input.id ? 'Debt updated' : 'Debt added'),
      deleteDebt: (id) => mutate(() => api.deleteDebt(id), 'Debt deleted'),
      saveDebtPayment: (input) =>
        mutate(() => api.saveDebtPayment(input), 'Repayment recorded'),
      deleteDebtPayment: (id) =>
        mutate(() => api.deleteDebtPayment(id), 'Repayment removed'),
      saveHolding: (input) =>
        mutate(
          () => api.saveHolding(input),
          input.id ? 'Holding updated' : 'Holding added',
        ),
      deleteHolding: (id) => mutate(() => api.deleteHolding(id), 'Holding deleted'),
      saveLot: (input) =>
        mutate(
          () => api.saveInvestmentLot(input),
          input.kind === 'buy' ? 'Purchase recorded' : 'Sale recorded',
        ),
      deleteLot: (id) => mutate(() => api.deleteInvestmentLot(id), 'Entry removed'),
      refreshPrices,
      pricesRefreshing,
      saveTransaction: (input) => mutate(() => api.saveTransaction(input)),
      deleteTransaction: (id) => mutate(() => api.deleteTransaction(id)),
      listTransactions: (query) => api.listTransactions(query),
      transactionSummary: (query) => api.transactionSummary(query),
      seedDemo: () => mutate(() => api.seedDemo(), 'Sample book loaded'),
      resetAll: () => mutate(() => api.resetAll(), 'Everything cleared'),
    }),
    [
      ready,
      fatal,
      accounts,
      categories,
      categoryUsage,
      debts,
      holdings,
      overview,
      month,
      span,
      theme,
      toggleTheme,
      toasts,
      toast,
      dismissToast,
      revision,
      mutate,
      refreshPrices,
      pricesRefreshing,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
