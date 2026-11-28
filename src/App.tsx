import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type MutableRefObject, type ReactNode,
} from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { INVESTMENT_TABS, Sidebar, isInvestmentRoute, type Route } from './components/Sidebar';
import { DrawerButton, MoreSheet, PhoneDrawer, TabBar } from './components/MobileChrome';
import {
  NATIVE_TAB_ROUTES, badgeNativeTab, holdNativeTabs, onNativeAdd, onNativeTab, selectNativeTab,
  showNativeTabs,
  type NativeTab,
} from './lib/nativeTabs';
import { api } from './lib/api';
import { newChat } from './lib/chat';
import { CommandPalette } from './components/CommandPalette';
import {
  TransactionSheet, type SplitFocus, type TxDraft,
} from './components/TransactionSheet';
import { AccountSheet } from './components/AccountSheet';
import { DebtSheet, DebtPaymentSheet, type DebtMovement } from './components/DebtSheet';
import { HoldingSheet, LotSheet } from './components/HoldingSheet';
import { PlanSheet, type PlanDraft } from './components/PlanSheet';
import { PlanLinkSheet } from './components/PlanLinkSheet';
import { Toasts } from './components/Toasts';
import { Button, Empty } from './components/ui';
import { Overview } from './screens/Overview';
import { Transactions } from './screens/Transactions';
import { Siri } from './screens/Siri';
import { Ask } from './screens/Ask';
import { Planned } from './screens/Planned';
import { Accounts } from './screens/Accounts';
import { Cards } from './screens/Cards';
import { Taxes } from './screens/Taxes';
import { Debts } from './screens/Debts';
import type { DebtPerson } from './lib/debts';
import { Investments } from './screens/Investments';
import { Categories } from './screens/Categories';
import { Folders } from './screens/Folders';
import { Labels } from './screens/Labels';
import { Templates } from './screens/Templates';
import { Settings } from './screens/Settings';
import { StoreProvider, useStore } from './lib/store';
import { usePhone } from './lib/media';
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
  'siri',
  'planned',
  'accounts',
  'cards',
  'taxes',
  'debts',
  'funds',
  'settings',
];

/** How far back the trail is kept. Long enough that nobody reaches the end
    of it in a session, short enough that nothing grows without bound. */
const HISTORY_MAX = 60;

/** One stop on the trail. The id is what tells two visits to the same screen
 *  apart, so each keeps its own place on the page. */
interface Stop {
  id: number;
  route: Route;
}

/**
 * Where you have been, and where you were before you came back. The trail is
 * a list of screens with a finger on the one being looked at: going somewhere
 * new cuts off whatever was ahead, which is what forward means once you have
 * taken a different turn.
 *
 * It also remembers how far down each stop was read. Coming back to a ledger
 * you were halfway through and being handed the top of it is the app losing
 * your place, not you.
 */
function useHistory(initial: Route) {
  const seq = useRef(0);
  const [trail, setTrail] = useState<{ stack: Stop[]; at: number }>(() => ({
    stack: [{ id: 0, route: initial }],
    at: 0,
  }));
  // Where each stop was scrolled to, by its id. A ref rather than state: it
  // changes as you scroll away from a screen, and nothing on screen depends
  // on it until you come back to one.
  const marks = useRef(new Map<number, number>());

  const navigate = useCallback((next: Route) => {
    setTrail((t) => {
      if (t.stack[t.at].route === next) return t;
      const stack = [...t.stack.slice(0, t.at + 1), { id: ++seq.current, route: next }];
      const trimmed = stack.slice(-HISTORY_MAX);
      // What was ahead is gone, and so is the far end of a trail this long.
      // Their places go with them rather than sitting in the map forever.
      const kept = new Set(trimmed.map((stop) => stop.id));
      for (const stop of t.stack) {
        if (!kept.has(stop.id)) marks.current.delete(stop.id);
      }
      return { stack: trimmed, at: trimmed.length - 1 };
    });
  }, []);

  const back = useCallback(() => {
    setTrail((t) => (t.at > 0 ? { ...t, at: t.at - 1 } : t));
  }, []);

  const forward = useCallback(() => {
    setTrail((t) => (t.at < t.stack.length - 1 ? { ...t, at: t.at + 1 } : t));
  }, []);

  const stop = trail.stack[trail.at];
  return {
    route: stop.route,
    stop: stop.id,
    marks,
    navigate,
    back,
    forward,
    canBack: trail.at > 0,
    canForward: trail.at < trail.stack.length - 1,
  };
}

/** How long to keep asking for an offset a screen cannot reach yet. */
const RESTORE_FRAMES = 60;

/**
 * The page itself: one scrolling box per stop on the trail, which puts back
 * the place that stop was left at and hands it back on the way out.
 *
 * A screen fills in as its reads come back, so the box is usually shorter
 * when it mounts than it will be a moment later — asking once would land you
 * partway down, or at the bottom of a page that had nothing in it yet. So the
 * offset is asked for again each frame until the page is long enough to hold
 * it, and given up on if it never is.
 */
/** How far the grain moves for each pixel the page does. */
const GROUND_DRIFT = 0.35;

function ScrollPane({
  stop, marks, children,
}: {
  stop: number;
  marks: MutableRefObject<Map<number, number>>;
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = pane.current;
    if (!node) return;
    const want = marks.current.get(stop) ?? 0;
    let frame = 0;
    let raf = 0;
    const settle = () => {
      if (!pane.current) return;
      pane.current.scrollTop = want;
      // Short of it because the page is still short: ask again next frame.
      if (pane.current.scrollTop < want - 0.5 && frame++ < RESTORE_FRAMES) {
        raf = requestAnimationFrame(settle);
      }
    };
    settle();
    return () => {
      cancelAnimationFrame(raf);
      // On the way out — after the screen has animated away, since that is
      // when React lets go of it — remember where it was left.
      marks.current.set(stop, node.scrollTop);
    };
  }, [stop, marks]);

  /* The paper's grain is painted on the shell, behind the page. It follows
     the page as it scrolls, but at a fraction of the speed, so the ground
     reads as a layer further back. Written straight to a custom property on
     the shell, once a frame at most: a re-render per scroll event would be
     the whole page redrawn to move a texture. */
  useEffect(() => {
    const node = pane.current;
    const shell = node?.closest<HTMLElement>('.app');
    if (!node || !shell) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      shell.style.setProperty('--ground-y', `${-node.scrollTop * GROUND_DRIFT}px`);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    paint();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <motion.div
      ref={pane}
      variants={screenVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="main-scroll"
    >
      {children}
    </motion.div>
  );
}

/* How long the splash stays: 140ms before the first stroke, 1150ms writing,
   then a beat to read it. Kept in step with the keyframes in index.html. */
const SPLASH_MS = 1850;
const SPLASH_EXIT_MS = 420;

function Shell() {
  const { ready, fatal, accounts, captures } = useStore();
  const {
    route, stop, marks, navigate: setRoute, back, forward, canBack, canForward,
  } = useHistory('overview');
  // Which shell is drawing: a sidebar down the side, or a bar top and bottom.
  const phone = usePhone();
  const [moreOpen, setMoreOpen] = useState(false);

  /* On iOS the tab bar is UIKit's (see `lib/nativeTabs`), and this is the
     height it covers once it is up; null while it is not, and always on the
     Mac or in a browser, where the page draws its own. */
  const [nativeTabsH, setNativeTabsH] = useState<number | null>(null);
  /* The phone's sidebar: every destination without a tab, slid in from the
     left by the edge swipe or the button at the top of each screen. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /* What the add button beside the native bar runs. A ref, because the
     listener is set up once and `newTransaction` is declared further down. */
  const newTransactionRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!phone) return;
    let live = true;
    showNativeTabs().then((h) => live && setNativeTabsH(h));
    return () => {
      live = false;
    };
  }, [phone]);
  useEffect(() => {
    if (nativeTabsH === null) return;
    const listeners = [
      onNativeTab((tab) => {
        setDrawerOpen(false);
        setRoute(tab);
      }),
      onNativeAdd(() => newTransactionRef.current()),
    ];
    return () => {
      for (const l of listeners) l.then((x) => x.unregister()).catch(() => {});
    };
  }, [nativeTabsH, setRoute]);
  // The lit tab follows the page, however the page got there.
  useEffect(() => {
    if (nativeTabsH === null) return;
    selectNativeTab(NATIVE_TAB_ROUTES.has(route) ? (route as NativeTab) : 'none');
  }, [nativeTabsH, route]);
  // The drawer covers the bar's corner of the screen, so the bar steps down
  // while it is out, as it does for a sheet.
  useEffect(() => {
    if (!drawerOpen) return;
    holdNativeTabs(true);
    return () => holdNativeTabs(false);
  }, [drawerOpen]);
  useEffect(() => {
    if (nativeTabsH === null) return;
    badgeNativeTab('siri', captures.length);
  }, [nativeTabsH, captures.length]);

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
  // The repayment sheet's subject: whose debt, which way the money went —
  // back, or more of it handed over — and which entry when one is being
  // changed rather than added.
  const [paying, setPaying] = useState<{
    debt: Debt;
    kind: DebtMovement;
    payment: DebtPayment | null;
    /** Set when the repayment is laid over everything a person owes. */
    person?: DebtPerson;
  } | null>(null);
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
  newTransactionRef.current = () => newTransaction();

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

  // Paying a plan is a new transaction too, opened as the plan describes the
  // cycle — and written only once somebody has checked it against what was
  // actually paid.
  const payPlan = useCallback(
    (plan: Plan) => {
      newTransaction({ plan });
    },
    [newTransaction],
  );

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
  }, [setRoute]);

  const openCategoryTransactions = useCallback((categoryId: string, span?: number) => {
    setCategoryFocus((f) => ({ ids: [categoryId], token: f.token + 1, span }));
    setRoute('transactions');
  }, [setRoute]);

  // A focus is an instruction given on the way to a screen, not a setting the
  // screen holds. Once the ledger has acted on one it is dropped, so coming
  // back later opens on the filters you left rather than on the ones you were
  // sent with — and cleared before that.
  const forgetFocus = useCallback(() => {
    const spend = (f: { token: number }) => f.token !== 0;
    setAccountFocus((f) => (spend(f) ? { ids: [], token: 0 } : f));
    setCategoryFocus((f) => (spend(f) ? { ids: [], token: 0 } : f));
    setLabelFocus((f) => (spend(f) ? { ids: [], token: 0 } : f));
  }, []);

  const openLabelTransactions = useCallback((labelId: string) => {
    setLabelFocus((f) => ({ ids: [labelId], token: f.token + 1 }));
    setRoute('transactions');
  }, [setRoute]);

  // Each sleeve is a route of its own, so arriving from a gold card lands on
  // gold and the sidebar says so.
  const openInvestments = useCallback(
    (kind: InvestmentTab) => {
      setRoute(kind === 'gold' ? 'gold' : kind === 'deposit' ? 'deposits' : 'funds');
    },
    [setRoute],
  );

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
      // ⌘[ and ⌘] , and the arrows Safari and Finder answer to as well.
      if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        back();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === ']' || e.key === 'ArrowRight')) {
        e.preventDefault();
        forward();
        return;
      }
      // ⌘⇧O, a new chat in Ask from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        newChat();
        setRoute('ask');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
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
  }, [newTransaction, setRoute, back, forward]);

  /* The drawer, by dragging in from the left edge — where the sidebar is on
     the Mac, and where a thumb looks for it. It used to be back; the drawer
     is the only way to half the destinations now, so it has the gesture. It
     is deliberately narrow-minded:
     the drag has to start within 22pt of the edge, travel mostly sideways,
     and finish before the thumb has had time to mean something else. A screen
     with its own horizontal scrolling — a rail of chips, a wide table — sits
     past that 22pt strip and is never in the running. */
  useEffect(() => {
    if (!phone) return;
    let from: { x: number; y: number; at: number } | null = null;

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      from = touch && touch.clientX <= 22
        ? { x: touch.clientX, y: touch.clientY, at: performance.now() }
        : null;
    };
    const onEnd = (e: TouchEvent) => {
      const start = from;
      from = null;
      const touch = e.changedTouches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx > 68 && dy < 46 && performance.now() - start.at < 700) setDrawerOpen(true);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [phone]);

  /* How much of the window the keyboard is sitting on, published as `--kb`.
     WKWebView does not resize the viewport when the keyboard comes up — the
     page keeps its full height and the bottom of it is simply covered — so a
     sheet's footer, and the field being typed into, end up underneath it.
     `visualViewport` is the only thing that knows, and this is the only place
     that has to ask. */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      root.style.setProperty('--kb', `${Math.max(0, Math.round(covered))}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      root.style.removeProperty('--kb');
    };
  }, []);

  /* The splash painted by index.html hands over to the app. The book usually
     opens faster than the wordmark finishes writing itself, so the splash is
     held to its full length rather than cut off mid-stroke. It is dismissed on
     `fatal` too, so an error is never left sitting behind it. */
  useEffect(() => {
    if (!ready && !fatal) return;
    const splash = document.getElementById('splash');
    if (!splash) return;

    /* performance.now() is time since the document loaded, which is when the
       splash first painted — so it is the elapsed time without a global. */
    const wait = Math.max(0, SPLASH_MS - performance.now());
    let bail = 0;
    const done = () => splash.remove();

    const leave = window.setTimeout(() => {
      splash.classList.add('is-gone');
      splash.addEventListener('transitionend', done, { once: true });
      bail = window.setTimeout(done, SPLASH_EXIT_MS + 200);
    }, wait);

    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(bail);
    };
  }, [ready, fatal]);

  if (!ready) {
    return (
      <div className="boot">
        <span className="boot-mark">flow</span>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="boot boot-failed">
        <div className="boot-error">
          <Empty art="fail" tone="red" title="flow could not open your book" body={fatal} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`app ${phone ? 'is-phone' : ''} ${nativeTabsH !== null ? 'has-native-tabs' : ''}`}
      style={nativeTabsH !== null ? ({ '--tabs-h': `${nativeTabsH}px` } as CSSProperties) : undefined}
    >
      {/* A phone has no bar across the top: the page starts under the
          status bar, back is the edge swipe, and the tab bar does the rest. */}
      {!phone && (
        <Sidebar
          route={route}
          onNavigate={setRoute}
          onBack={back}
          onForward={forward}
          canBack={canBack}
          canForward={canForward}
          onAdd={() => newTransaction()}
          onSearch={() => setPaletteOpen(true)}
        />
      )}

      <main className="main">
        {/* A strip the window is dragged by, which a phone has no use for —
            and which would otherwise sit over the top of every screen
            swallowing the taps meant for it. */}
        {!phone && <div className="titlebar-drag main-drag" data-tauri-drag-region />}
        <AnimatePresence mode="wait">
          <ScrollPane key={stop} stop={stop} marks={marks}>
            {accounts.length === 0 && route !== 'settings' ? (
              <div className="screen">
                <div className="welcome">
                  <Empty
                    art="wallet"
                    title="Welcome to flow"
                    body="A bank, a card, a wallet: wherever your money sits."
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
                onFocusUsed={forgetFocus}
                onAskAbout={() => setRoute('ask')}
              />
            ) : route === 'planned' ? (
              <Planned
                onNewPlan={newPlan}
                onEditPlan={editPlan}
                onLinkPlan={setLinkingPlan}
                onPayPlan={payPlan}
                onOpenTransaction={openTransactionById}
              />
            ) : route === 'accounts' ? (
              <Accounts onEditAccount={editAccount} onAddAccount={newAccount} />
            ) : route === 'cards' ? (
              <Cards
                onOpenAccount={openAccountTransactions}
                onEditAccount={editAccount}
                onAddAccount={newAccount}
                onOpenCategory={openCategoryTransactions}
                onOpenTransaction={openTransaction}
              />
            ) : route === 'taxes' ? (
              <Taxes onOpenTransaction={openTransaction} />
            ) : route === 'debts' ? (
              <Debts
                onNewDebt={newDebt}
                onEditDebt={editDebt}
                onRecordPayment={(debt) => setPaying({ debt, kind: 'repayment', payment: null })}
                onEditPayment={(debt, payment) => setPaying({ debt, kind: 'repayment', payment })}
                onAddMore={(debt) => setPaying({ debt, kind: 'addition', payment: null })}
                onEditAddition={(debt, addition) =>
                  setPaying({ debt, kind: 'addition', payment: addition })
                }
                onRepayPerson={(person, payment) =>
                  setPaying({
                    debt: person.debts[person.debts.length - 1],
                    kind: 'repayment',
                    payment,
                    person,
                  })
                }
                onOpenTransaction={openTransaction}
              />
            ) : isInvestmentRoute(route) ? (
              <Investments
                tab={INVESTMENT_TABS[route]}
                onNewHolding={newHolding}
                onEditHolding={editHolding}
                onAddLot={(holding) => setLotTarget({ holding, lot: null })}
                onEditLot={(holding, lot) => setLotTarget({ holding, lot })}
              />
            ) : route === 'ask' ? (
              <Ask onOpenSettings={() => setRoute('settings')} />
            ) : route === 'siri' ? (
              <Siri onOpenTransaction={openTransactionById} />
            ) : route === 'categories' ? (
              <Categories onOpenCategory={openCategoryTransactions} />
            ) : route === 'labels' ? (
              <Labels onOpenLabel={openLabelTransactions} />
            ) : route === 'folders' ? (
              <Folders
                onOpenTransaction={openTransaction}
                onSplitTransaction={splitTransaction}
                onOweTransaction={oweTransaction}
                onRefundTransaction={refundTransaction}
              />
            ) : route === 'templates' ? (
              <Templates
                onUseTemplate={useTemplate}
                onAddTransaction={() => newTransaction()}
              />
            ) : (
              <Settings />
            )}
          </ScrollPane>
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
        person={paying?.person ?? null}
        kind={paying?.kind}
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
      {phone && (
        <>
          {nativeTabsH === null && <TabBar
            route={route}
            onNavigate={(next) => {
              setMoreOpen(false);
              setRoute(next);
            }}
            onAdd={() => newTransaction()}
            onMore={() => setMoreOpen((open) => !open)}
            moreOpen={moreOpen}
          />}
          <MoreSheet
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            route={route}
            onNavigate={setRoute}
          />
          <DrawerButton onClick={() => setDrawerOpen(true)} />
          <PhoneDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            route={route}
            onNavigate={setRoute}
          />
        </>
      )}

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
