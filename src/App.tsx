import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sidebar, type Route } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import {
  TransactionSheet, type SplitFocus, type TxDraft,
} from './components/TransactionSheet';
import { AccountSheet } from './components/AccountSheet';
import { DebtSheet, DebtPaymentSheet } from './components/DebtSheet';
import { HoldingSheet, LotSheet } from './components/HoldingSheet';
import { Toasts } from './components/Toasts';
import { Button, Empty } from './components/ui';
import { Overview } from './screens/Overview';
import { Transactions } from './screens/Transactions';
import { Accounts } from './screens/Accounts';
import { Debts } from './screens/Debts';
import { Investments } from './screens/Investments';
import { Insights } from './screens/Insights';
import { Categories } from './screens/Categories';
import { Settings } from './screens/Settings';
import { StoreProvider, useStore } from './lib/store';
import { screenVariants } from './lib/motion';
import type {
  Account,
  Debt,
  DebtDirection,
  Holding,
  HoldingKind,
  InvestmentLot,
  Transaction,
  TxKind,
} from './lib/types';

const ROUTE_KEYS: Route[] = [
  'overview',
  'transactions',
  'accounts',
  'debts',
  'investments',
  'insights',
  'settings',
];

function Shell() {
  const { ready, fatal, accounts, seedDemo } = useStore();
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
  const [paymentFor, setPaymentFor] = useState<Debt | null>(null);
  const [holdingOpen, setHoldingOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState<Holding | null>(null);
  const [holdingKind, setHoldingKind] = useState<HoldingKind>('fund');
  // Which tab Investments opens on. The screen remounts with the route, so
  // arriving from a gold card lands on gold rather than on whatever was last
  // looked at.
  const [investmentTab, setInvestmentTab] = useState<HoldingKind>('fund');
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
  // The same trick for a category picked off a breakdown: the ledger opens
  // filtered to it, over all time rather than the month you happened to be
  // looking at, because "show me these" means all of them.
  const [categoryFocus, setCategoryFocus] = useState<{ ids: string[]; token: number }>({
    ids: [],
    token: 0,
  });

  const newTransaction = useCallback((next?: TxDraft) => {
    setEditingTx(null);
    setDraft(next);
    setSplitFocus(null);
    setTxOpen(true);
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

  const newAccount = useCallback(() => {
    setEditingAccount(null);
    setAccountOpen(true);
  }, []);

  const openAccountTransactions = useCallback((accountId: string) => {
    setAccountFocus((f) => ({ ids: [accountId], token: f.token + 1 }));
    setRoute('transactions');
  }, []);

  const openCategoryTransactions = useCallback((categoryId: string) => {
    setCategoryFocus((f) => ({ ids: [categoryId], token: f.token + 1 }));
    setRoute('transactions');
  }, []);

  const openInvestments = useCallback((kind: HoldingKind) => {
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
      if ((e.metaKey || e.ctrlKey) && /^[1-7]$/.test(e.key)) {
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
                    body="Start with an account of your own, or load a sample book to look around first."
                    action={
                      <div className="welcome-actions">
                        <Button tone="primary" icon="plus" onClick={newAccount}>
                          Create an account
                        </Button>
                        <Button icon="sparkles" onClick={() => seedDemo()}>
                          Load sample data
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
              />
            ) : route === 'transactions' ? (
              <Transactions
                onOpenTransaction={openTransaction}
                onSplitTransaction={splitTransaction}
                onAddTransaction={() => newTransaction()}
                accountFocus={accountFocus}
                categoryFocus={categoryFocus}
              />
            ) : route === 'accounts' ? (
              <Accounts onEditAccount={editAccount} onAddAccount={newAccount} />
            ) : route === 'debts' ? (
              <Debts
                onNewDebt={newDebt}
                onEditDebt={editDebt}
                onRecordPayment={setPaymentFor}
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
      />
      <DebtPaymentSheet
        open={!!paymentFor}
        onClose={() => setPaymentFor(null)}
        debt={paymentFor}
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
