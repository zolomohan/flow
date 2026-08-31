import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sidebar, type Route } from './components/Sidebar';
import { api } from './lib/api';
import { CommandPalette } from './components/CommandPalette';
import {
  TransactionSheet, type SplitFocus, type TxDraft,
} from './components/TransactionSheet';
import { AccountSheet } from './components/AccountSheet';
import { DebtSheet, DebtPaymentSheet } from './components/DebtSheet';
import { HoldingSheet, LotSheet } from './components/HoldingSheet';
import { PlanSheet, type PlanDraft } from './components/PlanSheet';
import { PlanLinkSheet } from './components/PlanLinkSheet';
import { Toasts } from './components/Toasts';
import { Button, Empty } from './components/ui';
import { Overview } from './screens/Overview';
import { Transactions } from './screens/Transactions';
import { Planned } from './screens/Planned';
import { Accounts } from './screens/Accounts';
import { Debts } from './screens/Debts';
import { Investments } from './screens/Investments';
import { Insights } from './screens/Insights';
import { Categories } from './screens/Categories';
import { Labels } from './screens/Labels';
import { Templates } from './screens/Templates';
import { Settings } from './screens/Settings';
import { StoreProvider, useStore } from './lib/store';
import { screenVariants } from './lib/motion';
import type {
  Account,
  Debt,
  DebtPayment,
  DebtDirection,
  Holding,
  HoldingKind,
  InvestmentTab,
  InvestmentLot,
  Plan,
  Transaction,
  TxKind,
  TxTemplate,
} from './lib/types';

const ROUTE_KEYS: Route[] = [
  'overview',
  'transactions',
  'planned',
  'accounts',
  'debts',
  'investments',
  'insights',
  'settings',
];

function Shell() {
  const { ready, fatal, accounts } = useStore();
  const [route, setRoute] = useState<Route>('overview');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [draft, setDraft] = useState<TxDraft | undefined>();
  const [splitFocus, setSplitFocus] = useState<SplitFocus | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [debtOpen, setDebtOpen] = useState(false);
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  const [debtDirection, setDebtDirection] = useState<DebtDirection>('lent');
  // The repayment sheet's subject: whose debt, and which repayment when one
  // is being changed rather than added.
  const [paying, setPaying] = useState<{ debt: Debt; payment: DebtPayment | null } | null>(null);
  // The plan sheet's subject: the one being changed, or nothing when a new
  // one is being written.
  const [planOpen, setPlanOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [planDraft, setPlanDraft] = useState<PlanDraft | undefined>();
  // The plan whose payments are being picked out of the ledger.
  const [linkingPlan, setLinkingPlan] = useState<Plan | null>(null);
  const [holdingOpen, setHoldingOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState<Holding | null>(null);
  const [holdingKind, setHoldingKind] = useState<HoldingKind>('fund');
  // Which tab Investments opens on. The screen remounts with the route, so
  // arriving from a gold card lands on gold rather than on whatever was last
  // looked at.
  const [investmentTab, setInvestmentTab] = useState<InvestmentTab>('fund');
  // One target for both paths: the holding a new entry belongs to, and the
  // existing entry when one is being corrected.
  const [lotTarget, setLotTarget] = useState<{
    holding: Holding;
    lot: InvestmentLot | null;
  } | null>(null);
  // A token rather than the ids alone, so clicking the same account twice
  // re-applies the filter even after it has been cleared by hand.
  const [accountFocus, setAccountFocus] = useState<{ ids: string[]; token: number }>({
    ids: [],
    token: 0,
  });
  // The same trick for a category picked off a breakdown. `span` is how many
  // months the breakdown was about: a dashboard asking "where did August go"
  // should answer in August, while a list that stands for the whole book
  // leaves it unset and the ledger opens over all time.
  const [categoryFocus, setCategoryFocus] = useState<{
    ids: string[];
    token: number;
    span?: number;
  }>({ ids: [], token: 0 });
  // And the same again for a label picked off the Labels screen.
  const [labelFocus, setLabelFocus] = useState<{ ids: string[]; token: number }>({
    ids: [],
    token: 0,
  });

  const newTransaction = useCallback((next?: TxDraft) => {
    setEditingTx(null);
    setDraft(next);
    setSplitFocus(null);
    setTxOpen(true);
  }, []);

  // Opening whatever a debt or a repayment names: the sheet asking gives way
  // to the posting itself, since one modal over another is nobody's idea of
  // where they are.
  const openTransactionById = useCallback(async (id: string) => {
    try {
      const tx = await api.transaction(id);
      setPaying(null);
      setDebtOpen(false);
      setDraft(undefined);
      setEditingTx(tx);
      setSplitFocus(null);
      setTxOpen(true);
    } catch {
      /* it is gone, and the sheet says nothing rather than the wrong thing */
    }
  }, []);

  const openTransaction = useCallback((tx: Transaction) => {
    setDraft(undefined);
    setEditingTx(tx);
    setSplitFocus(null);
    setTxOpen(true);
  }, []);

  // Splitting is the same sheet, opened with its people panel already down.
  const splitTransaction = useCallback((tx: Transaction) => {
    setDraft(undefined);
    setEditingTx(tx);
    setSplitFocus('people');
    setTxOpen(true);
  }, []);

  // The whole of a posting owed by one person: the same sheet again, opened
  // on its people page with nobody's share reserved.
  const oweTransaction = useCallback((tx: Transaction) => {
    setDraft(undefined);
    setEditingTx(tx);
    setSplitFocus('debt');
    setTxOpen(true);
  }, []);

  // Giving a posting back. A new one — the money coming home is its own entry
  // in the ledger — opened as the other side of what it undoes.
  const refundTransaction = useCallback((tx: Transaction) => {
    setEditingTx(null);
    setDraft({ refund: tx });
    setSplitFocus(null);
    setTxOpen(true);
  }, []);

  // A template is a new transaction with the form already filled in — the
  // same sheet, opened on a shape somebody kept.
  const useTemplate = useCallback(
    (template: TxTemplate) => {
      newTransaction({ template });
    },
    [newTransaction],
  );

  const newAccount = useCallback(() => {
    setEditingAccount(null);
    setAccountOpen(true);
  }, []);

  const openAccountTransactions = useCallback((accountId: string) => {
    setAccountFocus((f) => ({ ids: [accountId], token: f.token + 1 }));
    setRoute('transactions');
  }, []);

  const openCategoryTransactions = useCallback((categoryId: string, span?: number) => {
    setCategoryFocus((f) => ({ ids: [categoryId], token: f.token + 1, span }));
    setRoute('transactions');
  }, []);

  const openLabelTransactions = useCallback((labelId: string) => {
    setLabelFocus((f) => ({ ids: [labelId], token: f.token + 1 }));
    setRoute('transactions');
  }, []);

  const openInvestments = useCallback((kind: InvestmentTab) => {
    setInvestmentTab(kind);
    setRoute('investments');
  }, []);

  const newDebt = useCallback((direction: DebtDirection) => {
    setEditingDebt(null);
    setDebtDirection(direction);
    setDebtOpen(true);
  }, []);

  const editDebt = useCallback((debt: Debt) => {
    setEditingDebt(debt);
    setDebtOpen(true);
  }, []);

  const newPlan = useCallback((next?: PlanDraft) => {
    setEditingPlan(null);
    setPlanDraft(next);
    setPlanOpen(true);
  }, []);

  const editPlan = useCallback((plan: Plan) => {
    setPlanDraft(undefined);
    setEditingPlan(plan);
    setPlanOpen(true);
  }, []);

  const newHolding = useCallback((kind: HoldingKind) => {
    setEditingHolding(null);
    setHoldingKind(kind);
    setHoldingOpen(true);
  }, []);

  const editHolding = useCallback((holding: Holding) => {
    setEditingHolding(holding);
    setHoldingOpen(true);
  }, []);

  const editAccount = useCallback((account: Account) => {
    setEditingAccount(account);
    setAccountOpen(true);
  }, []);

  // Global keys. Anything typed into a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-8]$/.test(e.key)) {
        e.preventDefault();
        setRoute(ROUTE_KEYS[Number(e.key) - 1]);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newTransaction();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newTransaction]);

  if (!ready) {
    return (
      <div className="boot">
        <motion.span
          className="boot-mark"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
        >
          M
        </motion.span>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="boot">
        <div className="boot-error">
          <Empty icon="alert-circle" title="Midas could not open your book" body={fatal} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        route={route}
        onNavigate={setRoute}
        onAdd={() => newTransaction()}
        onSearch={() => setPaletteOpen(true)}
      />

      <main className="main">
        <div className="titlebar-drag main-drag" data-tauri-drag-region />
        <AnimatePresence mode="wait">
          <motion.div
            key={route}
            variants={screenVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="main-scroll"
          >
            {accounts.length === 0 && route !== 'settings' ? (
              <div className="screen">
                <div className="welcome">
                  <Empty
                    icon="sparkles"
                    title="Welcome to Midas"
                    body="Start with an account of your own, or bring a book you have already kept somewhere else."
                    action={
                      <div className="welcome-actions">
                        <Button tone="primary" icon="plus" onClick={newAccount}>
                          Create an account
                        </Button>
                      </div>
                    }
                  />
                </div>
              </div>
            ) : route === 'overview' ? (
              <Overview
                onOpenTransaction={openTransaction}
                onAddTransaction={() => newTransaction()}
                onGoTransactions={() => setRoute('transactions')}
                onOpenAccount={openAccountTransactions}
                onOpenCategory={openCategoryTransactions}
                onGoInvestments={openInvestments}
                onGoDebts={() => setRoute('debts')}
                onGoAccounts={() => setRoute('accounts')}
                onGoPlanned={() => setRoute('planned')}
              />
            ) : route === 'transactions' ? (
              <Transactions
                onOpenTransaction={openTransaction}
                onSplitTransaction={splitTransaction}
                onOweTransaction={oweTransaction}
                onRefundTransaction={refundTransaction}
                onAddTransaction={() => newTransaction()}
                accountFocus={accountFocus}
                categoryFocus={categoryFocus}
                labelFocus={labelFocus}
              />
            ) : route === 'planned' ? (
              <Planned
                onNewPlan={newPlan}
                onEditPlan={editPlan}
                onLinkPlan={setLinkingPlan}
                onOpenTransaction={openTransactionById}
              />
            ) : route === 'accounts' ? (
              <Accounts onEditAccount={editAccount} onAddAccount={newAccount} />
            ) : route === 'debts' ? (
              <Debts
                onNewDebt={newDebt}
                onEditDebt={editDebt}
                onRecordPayment={(debt) => setPaying({ debt, payment: null })}
                onEditPayment={(debt, payment) => setPaying({ debt, payment })}
                onOpenTransaction={openTransaction}
              />
            ) : route === 'investments' ? (
              <Investments
                initialTab={investmentTab}
                onNewHolding={newHolding}
                onEditHolding={editHolding}
                onAddLot={(holding) => setLotTarget({ holding, lot: null })}
                onEditLot={(holding, lot) => setLotTarget({ holding, lot })}
              />
            ) : route === 'insights' ? (
              <Insights onOpenCategory={openCategoryTransactions} />
            ) : route === 'categories' ? (
              <Categories onOpenCategory={openCategoryTransactions} />
            ) : route === 'labels' ? (
              <Labels onOpenLabel={openLabelTransactions} />
            ) : route === 'templates' ? (
              <Templates
                onUseTemplate={useTemplate}
                onAddTransaction={() => newTransaction()}
              />
            ) : (
              <Settings />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <TransactionSheet
        open={txOpen}
        onClose={() => setTxOpen(false)}
        editing={editingTx}
        draft={draft}
        splitFocus={splitFocus}
      />
      <AccountSheet
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        editing={editingAccount}
      />
      <DebtSheet
        open={debtOpen}
        onClose={() => setDebtOpen(false)}
        editing={editingDebt}
        seedDirection={debtDirection}
        onOpenTransaction={openTransactionById}
      />
      <DebtPaymentSheet
        open={!!paying}
        onClose={() => setPaying(null)}
        debt={paying?.debt ?? null}
        editing={paying?.payment ?? null}
        onOpenTransaction={openTransactionById}
      />
      <PlanLinkSheet
        open={!!linkingPlan}
        onClose={() => setLinkingPlan(null)}
        plan={linkingPlan}
      />
      <PlanSheet
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        editing={editingPlan}
        draft={planDraft}
      />
      <HoldingSheet
        open={holdingOpen}
        onClose={() => setHoldingOpen(false)}
        editing={editingHolding}
        seedKind={holdingKind}
      />
      <LotSheet
        open={!!lotTarget}
        onClose={() => setLotTarget(null)}
        holding={lotTarget?.holding ?? null}
        editing={lotTarget?.lot}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setRoute}
        onNewTransaction={(kind: TxKind) => newTransaction({ kind })}
        onUseTemplate={useTemplate}
        onOpenTransaction={openTransaction}
      />
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
