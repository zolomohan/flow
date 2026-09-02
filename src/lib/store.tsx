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
import { monthKey, setAmountsHidden } from './format';
import { isDeposit } from './types';
import type {
  Account,
  BulkResult,
  Capture,
  CaptureSync,
  AccountInput,
  Category,
  CategoryDeleteOptions,
  CategoryInput,
  Debt,
  DebtInput,
  DebtPaymentInput,
  Holding,
  HoldingInput,
  ImportCommitRow,
  ImportResult,
  InvestmentLotInput,
  Label,
  LabelInput,
  Overview,
  Paise,
  Plan,
  PlanInput,
  Transaction,
  TransactionInput,
  TransactionPatch,
  TransactionQuery,
  TransactionSummary,
  TxTemplate,
  TxTemplateInput,
} from './types';

/**
 * Settings the book keeps for itself, by the key they are stored under. They
 * live here rather than on the screen that toggles them: the screens that
 * obey a setting have no business importing the one that sets it.
 */
export const REQUIRE_NOTE = 'require_note';

/**
 * Whether every figure comes out hidden. A book left open on a desk shows
 * what you have to whoever walks past, and a shared screen shows it to the
 * room: with this on, an amount prints as the shape of itself — ₹•,••,••• —
 * and the words around it are left alone. Nothing in the book changes; this
 * is about what the screen says, not what it holds.
 */
export const HIDE_AMOUNTS = 'hide_amounts';

/**
 * Whose book this is. The sidebar wears it in place of the app's own name,
 * and the Data screen is where it is changed. Blank falls back to the app's
 * name rather than leaving the corner empty.
 */
export const OWNER_NAME = 'owner_name';
export const OWNER_FALLBACK = 'Midas';

/**
 * The account the last transaction was written against, so the next one
 * opens on it. Most people spend from the same account for weeks at a time,
 * and picking it again every entry is the sort of work a book should do for
 * itself.
 */
export const LAST_ACCOUNT = 'last_account';

/** The looks Midas comes in: one light, and three darks of different colour. */
export type Theme = 'light' | 'midnight' | 'graphite' | 'black';

export const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Paper grey' },
  { value: 'midnight', label: 'Midnight', hint: 'Deep navy' },
  { value: 'graphite', label: 'Graphite', hint: 'Very dark grey' },
  { value: 'black', label: 'Pitch black', hint: 'True black' },
];

/**
 * The theme as it was left. `dark` is what the two-way switch used to write,
 * and midnight is that same navy under its new name.
 */
function storedTheme(): Theme {
  const saved = localStorage.getItem('midas.theme');
  if (saved === 'dark') return 'midnight';
  return THEMES.some((t) => t.value === saved) ? (saved as Theme) : 'light';
}

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
  /** Every label in the book, with how many postings carry each. */
  labels: Label[];
  /** Saved transaction templates, what you reach for most first. */
  templates: TxTemplate[];
  /** Every planned payment, soonest due first. */
  plans: Plan[];
  overview: Overview | null;
  /** Last month of the period in view. */
  month: string;
  setMonth: (m: string) => void;
  /** How many months that period covers — 1 for a month, 12 for a year. */
  span: number;
  setSpan: (n: number) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Light ↔ whichever dark theme was last in use, for the sidebar switch. */
  toggleTheme: () => void;
  /** The book's own preferences, as they are stored: strings, keyed. */
  settings: Record<string, string>;
  saveSetting: (key: string, value: string) => Promise<void>;
  toasts: Toast[];
  toast: (message: string, tone?: Toast['tone'], undo?: () => void) => void;
  dismissToast: (id: number) => void;
  saveAccount: (input: AccountInput) => Promise<Account>;
  deleteAccount: (id: string) => Promise<void>;
  setAccountArchived: (id: string, archived: boolean) => Promise<void>;
  saveCategory: (input: CategoryInput) => Promise<Category>;
  /** Writes a new order for one kind's categories, flattened parent-then-children. */
  reorderCategories: (ids: string[]) => Promise<void>;
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
  /** One change over many postings. Resolves with what it actually did. */
  updateTransactions: (ids: string[], patch: TransactionPatch) => Promise<BulkResult>;
  deleteTransactions: (ids: string[]) => Promise<number>;
  listTransactions: (query?: TransactionQuery) => Promise<Transaction[]>;
  transactionSummary: (query?: TransactionQuery) => Promise<TransactionSummary>;
  /** Posts a statement's agreed rows into one account. */
  commitStatementImport: (accountId: string, rows: ImportCommitRow[]) => Promise<ImportResult>;
  /** Marks postings as verified: Triage off, their filing remembered. */
  confirmTriage: (ids: string[]) => Promise<number>;
  /** What has been said to a phone and is still waiting for a person. */
  captures: Capture[];
  /** Everything said out loud that made it into the ledger, newest first. */
  captureHistory: Capture[];
  /** What the last read of the drop file did, and where it looked. Null
   *  until the first read, which happens as the book opens. */
  lastCaptureSync: CaptureSync | null;
  /** Reads the drop file again. Resolves either way — a missing folder is
   *  the ordinary state of a book nobody has dictated to yet. */
  syncCaptures: () => Promise<void>;
  /** Writes one waiting capture into the ledger, wearing Triage. */
  postCapture: (id: string, input: TransactionInput) => Promise<Transaction>;
  dismissCapture: (id: string) => Promise<void>;
  saveLabel: (input: LabelInput) => Promise<Label>;
  deleteLabel: (id: string) => Promise<void>;
  savePlan: (input: PlanInput) => Promise<Plan>;
  deletePlan: (id: string) => Promise<void>;
  setPlanArchived: (id: string, archived: boolean) => Promise<void>;
  /** Lets the cycle now due go by unpaid. */
  skipPlan: (id: string) => Promise<Plan>;
  /** Writes the posting a cycle describes and points the plan at it. */
  payPlan: (id: string, amount?: Paise | null, occurredAt?: string | null) => Promise<Transaction>;
  /** Says these postings belong to this plan. Resolves with how many. */
  linkPlanPostings: (planId: string, ids: string[]) => Promise<number>;
  /** Takes one back off. The posting itself stays where it is. */
  unlinkPlanPosting: (planId: string, transactionId: string) => Promise<void>;
  saveTemplate: (input: TxTemplateInput) => Promise<TxTemplate>;
  deleteTemplate: (id: string) => Promise<void>;
  /** Counts one posting written from a template. Quiet: it changes nothing
   *  of yours, only where the template sits in the list. */
  markTemplateUsed: (id: string) => Promise<void>;
  resetAll: () => Promise<void>;
  /** Files a category under a tax head; null puts it back on the undecided
   *  pile. Quiet: the tab redraws, and a toast per tag would drown it. */
  setTaxTag: (categoryId: string, tag: string | null) => Promise<void>;
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
  const [labels, setLabels] = useState<Label[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [captureHistory, setCaptureHistory] = useState<Capture[]>([]);
  const [lastCaptureSync, setLastCaptureSync] = useState<CaptureSync | null>(null);
  const [templates, setTemplates] = useState<TxTemplate[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [pricesRefreshing, setPricesRefreshing] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [month, setMonth] = useState(monthKey());
  const [span, setSpan] = useState(1);
  const [revision, setRevision] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  // Which dark the switch returns to, so leaving black for light and coming
  // back does not land you in midnight.
  const lastDark = useRef<Theme>(theme === 'light' ? 'midnight' : theme);
  const toastSeq = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('midas.theme', theme);
    if (theme !== 'light') lastDark.current = theme;
  }, [theme]);

  // Whether figures print hidden, handed to the formatter as this renders
  // rather than in an effect: everything below reads it on this very pass,
  // and an effect would set it after the amounts had already been drawn.
  setAmountsHidden(settings[HIDE_AMOUNTS] === '1');

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'light' ? lastDark.current : 'light')),
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
      const [
        nextAccounts, nextCategories, nextUsage, nextDebts, nextHoldings, nextOverview,
        nextSettings, nextLabels, nextTemplates, nextPlans, nextCaptures, nextSpoken,
      ] = await Promise.all([
        api.listAccounts(),
        api.listCategories(),
        api.categoryUsage(),
        api.listDebts(),
        api.listHoldings(),
        api.overview(forMonth, forSpan),
        api.listSettings(),
        api.listLabels(),
        api.listTemplates(),
        api.listPlans(),
        api.listCaptures(),
        api.captureHistory(),
      ]);
      setAccounts(nextAccounts);
      setCategories(nextCategories);
      setCategoryUsage(nextUsage);
      setDebts(nextDebts);
      setHoldings(nextHoldings);
      setOverview(nextOverview);
      setSettings(nextSettings);
      setLabels(nextLabels);
      setTemplates(nextTemplates);
      setPlans(nextPlans);
      setCaptures(nextCaptures);
      setCaptureHistory(nextSpoken);
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

  // Reading the drop file writes nothing of yours until a capture resolves
  // cleanly, and a missing folder is not a failure worth a toast — so this
  // sits outside `mutate` and stays quiet unless something actually landed.
  const syncCaptures = useCallback(async () => {
    try {
      const result = await api.syncCaptures();
      setLastCaptureSync(result);
      if (result.found > 0) {
        setRevision((r) => r + 1);
        const posted = result.posted === 1 ? '1 posting written' : `${result.posted} postings written`;
        toast(
          result.pending > 0
            ? `${posted}, ${result.pending} waiting in the Inbox`
            : posted,
        );
      }
    } catch (err) {
      // Said once, on the screen that cares: a drop file that cannot be read
      // is a setup problem, not something to interrupt the day with.
      setLastCaptureSync(null);
      console.warn('captures', err);
    }
  }, [toast]);

  // What the phone said while you were away. Read as the book opens, and
  // again whenever you come back to the window — iCloud delivers on its own
  // schedule, and the moment you look is the moment it matters.
  useEffect(() => {
    if (!ready) return;
    void syncCaptures();
    const onFocus = () => void syncCaptures();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [ready, syncCaptures]);

  // Prices go stale overnight, so top them up once after the book loads. Doing
  // it here rather than inside the screen keeps the Overview's net worth right
  // even when the Investments screen is never opened.
  const primed = useRef(false);
  useEffect(() => {
    if (!ready || primed.current || !holdings.length) return;
    primed.current = true;
    const today = new Date().toISOString().slice(0, 10);
    // Only what the market prices. A deposit earns at a rate written into its
    // own terms — it has no NAV to go stale, and asking after one meant every
    // book holding nothing but deposits went to the network on every launch.
    const priced = holdings.filter((h) => !isDeposit(h.kind));
    if (priced.some((h) => !h.priceAsOf || h.priceAsOf < today)) void refreshPrices();
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
      labels,
      templates,
      plans,
      overview,
      month,
      setMonth,
      span,
      setSpan,
      theme,
      setTheme,
      toggleTheme,
      settings,
      // Kept locally as well as written down, so a toggle answers at once
      // rather than after a round trip through the book.
      saveSetting: async (key, value) => {
        setSettings((was) => ({ ...was, [key]: value }));
        await api.setSetting(key, value);
      },
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
      reorderCategories: (ids) => mutate(() => api.reorderCategories(ids), 'Order saved'),
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
      updateTransactions: (ids, patch) => mutate(() => api.updateTransactions(ids, patch)),
      deleteTransactions: (ids) => mutate(() => api.deleteTransactions(ids)),
      listTransactions: (query) => api.listTransactions(query),
      transactionSummary: (query) => api.transactionSummary(query),
      commitStatementImport: (accountId, rows) =>
        mutate(() => api.commitStatementImport(accountId, rows)),
      confirmTriage: (ids) => mutate(() => api.confirmTriage(ids)),
      captures,
      captureHistory,
      lastCaptureSync,
      syncCaptures,
      postCapture: (id, input) => mutate(() => api.postCapture(id, input), 'Added to the ledger'),
      dismissCapture: (id) => mutate(() => api.dismissCapture(id), 'Capture dismissed'),
      saveLabel: (input) =>
        mutate(() => api.saveLabel(input), input.id ? 'Label updated' : 'Label added'),
      deleteLabel: (id) => mutate(() => api.deleteLabel(id), 'Label deleted'),
      savePlan: (input) =>
        mutate(() => api.savePlan(input), input.id ? 'Plan updated' : 'Plan added'),
      deletePlan: (id) => mutate(() => api.deletePlan(id), 'Plan removed'),
      setPlanArchived: (id, archived) =>
        mutate(
          () => api.setPlanArchived(id, archived),
          archived ? 'Plan put away' : 'Plan brought back',
        ),
      skipPlan: (id) => mutate(() => api.skipPlan(id), 'Skipped this one'),
      payPlan: (id, amount, occurredAt) =>
        mutate(() => api.payPlan(id, amount ?? null, occurredAt ?? null), 'Marked as paid'),
      linkPlanPostings: (planId, ids) =>
        mutate(
          () => api.linkPlanPostings(planId, ids),
          ids.length === 1 ? 'Payment linked' : `${ids.length} payments linked`,
        ),
      unlinkPlanPosting: (planId, transactionId) =>
        mutate(() => api.unlinkPlanPosting(planId, transactionId), 'Payment unlinked'),
      saveTemplate: (input) =>
        mutate(
          () => api.saveTemplate(input),
          input.id ? 'Template updated' : 'Template saved',
        ),
      deleteTemplate: (id) => mutate(() => api.deleteTemplate(id), 'Template deleted'),
      // No toast and no error of its own: a count that failed to go up is
      // nothing the person writing a transaction needs to hear about.
      markTemplateUsed: async (id) => {
        try {
          await api.useTemplate(id);
          setRevision((r) => r + 1);
        } catch {
          /* the posting is written, which is the part that mattered */
        }
      },
      resetAll: () => mutate(() => api.resetAll(), 'Everything cleared'),
      setTaxTag: (categoryId, tag) => mutate(() => api.setTaxTag(categoryId, tag)),
    }),
    [
      ready,
      fatal,
      accounts,
      categories,
      categoryUsage,
      debts,
      holdings,
      labels,
      templates,
      plans,
      overview,
      month,
      span,
      theme,
      toggleTheme,
      settings,
      toasts,
      toast,
      dismissToast,
      revision,
      mutate,
      refreshPrices,
      pricesRefreshing,
      captures,
      captureHistory,
      lastCaptureSync,
      syncCaptures,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
