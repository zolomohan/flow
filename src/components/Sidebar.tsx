import { Fragment, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Icon, SiriMark } from './Icon';
import { OWNER_FALLBACK, OWNER_NAME, useStore } from '../lib/store';
import { money } from '../lib/format';
import { press, spring } from '../lib/motion';
import type { InvestmentTab } from '../lib/types';

export type Route =
  | 'overview'
  | 'transactions'
  | 'ask'
  | 'siri'
  | 'planned'
  | 'debts'
  | 'funds'
  | 'gold'
  | 'deposits'
  | 'accounts'
  | 'cards'
  | 'taxes'
  | 'categories'
  | 'labels'
  | 'folders'
  | 'templates'
  | 'settings';

/**
 * What each investment route opens the one Investments screen on. The three
 * sleeves are read differently enough — a fund against what it cost, gold
 * against what it weighs, a deposit against its own rate — that each gets a
 * line of its own here rather than a tab strip inside the screen.
 */
export const INVESTMENT_TABS = {
  funds: 'fund',
  gold: 'gold',
  deposits: 'deposit',
} as const satisfies Partial<Record<Route, InvestmentTab>>;

export const isInvestmentRoute = (route: Route): route is keyof typeof INVESTMENT_TABS =>
  route in INVESTMENT_TABS;

export interface NavItem {
  id: Route;
  label: string;
  icon: string;
}

export interface NavGroup {
  /** Left off the first block: a heading over Overview and the ledger would
   *  only be a word for "the app", which the window already says. */
  label?: string;
  items: NavItem[];
}

/**
 * Sixteen rows in one list said nothing about their own shape, so the
 * column is cut the way drivea's is: the day's work at the top under no
 * heading, then a named run for each kind of thing the rest of it is.
 * A heading over one or two rows would be furniture; each of these is long
 * enough to be worth naming.
 *
 * - The day's work: where the money went, the two ways of asking about it,
 *   and what is due.
 * - Money: what holds it and what is owed against it.
 * - Investments: the three sleeves, each priced its own way.
 * - Organise: the lists everything else is filed against.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
      { id: 'transactions', label: 'Transactions', icon: 'list-filter' },
      { id: 'ask', label: 'Ask', icon: 'messages-square' },
      { id: 'siri', label: 'Inbox', icon: 'sparkles' },
      { id: 'planned', label: 'Planned', icon: 'repeat' },
    ],
  },
  {
    label: 'Money',
    items: [
      { id: 'accounts', label: 'Accounts', icon: 'wallet-cards' },
      { id: 'cards', label: 'Cards', icon: 'credit-card' },
      { id: 'debts', label: 'Debts', icon: 'arrow-left-right' },
      { id: 'taxes', label: 'Taxes', icon: 'scroll-text' },
    ],
  },
  {
    label: 'Investments',
    items: [
      { id: 'funds', label: 'Mutual funds', icon: 'trending-up' },
      { id: 'gold', label: 'Gold', icon: 'coins' },
      { id: 'deposits', label: 'Deposits', icon: 'landmark' },
    ],
  },
  {
    label: 'Organise',
    items: [
      { id: 'categories', label: 'Categories', icon: 'tags' },
      { id: 'labels', label: 'Labels', icon: 'bookmark' },
      { id: 'folders', label: 'Folders', icon: 'folder' },
      { id: 'templates', label: 'Templates', icon: 'shapes' },
    ],
  },
];

/** Every row, in the order the column shows them. Exported because the
 *  phone's More sheet is this same list with the destinations that earned a
 *  tab taken out of it — one order, one place to change it, whichever shell
 *  is drawing it. */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export function Sidebar({
  route, onNavigate, onAdd, onSearch, onBack, onForward, canBack, canForward,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  onAdd: () => void;
  onSearch: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
}) {
  const { overview, theme, toggleTheme, settings, captures } = useStore();
  // Whose book this is, as set under Settings › Your data.
  const owner = settings[OWNER_NAME]?.trim() || OWNER_FALLBACK;

  const initial = owner.trim().charAt(0).toUpperCase() || 'F';

  /* The list fades out at whichever edge it runs past, rather than being cut
     off there: two variables the mask reads, set from how far it has
     scrolled, so the fades come and go with the scrolling and the ends of
     the list are drawn whole when they are in view. */
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop > 2 ? 1 : 0;
      const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 2 ? 1 : 0;
      el.style.setProperty('--fade-top', String(top));
      el.style.setProperty('--fade-bottom', String(bottom));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      watch.disconnect();
    };
  }, []);

  return (
    <aside className="sidebar">
      {/* Keeps the traffic lights clear of the brand mark. */}
      <div className="titlebar-drag" data-tauri-drag-region />

      {/* Back and forward belong in the title bar, on the traffic lights'
          line, at the far end of the sidebar. */}
      <div className="titlebar-nav">
        <motion.button
          whileTap={canBack ? press : undefined}
          transition={spring}
          className="titlebar-nav-btn"
          onClick={onBack}
          disabled={!canBack}
          aria-label="Back"
          title="Back  ⌘["
        >
          <Icon name="chevron-left" size={15} strokeWidth={2.4} />
        </motion.button>
        <motion.button
          whileTap={canForward ? press : undefined}
          transition={spring}
          className="titlebar-nav-btn"
          onClick={onForward}
          disabled={!canForward}
          aria-label="Forward"
          title="Forward  ⌘]"
        >
          <Icon name="chevron-right" size={15} strokeWidth={2.4} />
        </motion.button>
      </div>

      <div className="brand">
        {/* Whose book this is: their initial on the brand's navy, the same
            badge drivea heads its column with. */}
        <span className="brand-mark" aria-hidden>{initial}</span>
        <div className="brand-text">
          <strong>{owner}</strong>
          <span>{overview ? money(overview.netWorth) : '—'}</span>
        </div>
      </div>

      <button className="side-search" onClick={onSearch}>
        <Icon name="search" size={15} />
        <span className="side-label">Search</span>
        <span className="side-kbd">
          <kbd>⌘</kbd>
          <kbd>K</kbd>
        </span>
      </button>

      {/* Only the lists scroll. A window too short for the column takes the
          room out of these, so the brand, Search, Add and Settings stay
          where they are put at any height. */}
      <div className="side-scroll" ref={scroller}>
        {NAV_GROUPS.map((group) => (
          <Fragment key={group.label ?? 'top'}>
            {group.label && <p className="nav-group-label">{group.label}</p>}
            <nav className="nav" aria-label={group.label}>
              {group.items.map((item) => {
                const active = item.id === route;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${active ? 'is-active' : ''}`}
                    onClick={() => onNavigate(item.id)}
                    title={item.label}
                  >
                    {active && (
                      <motion.span layoutId="nav-pill" className="nav-pill" transition={spring} />
                    )}
                    <span className="nav-content">
                      {/* Siri is the one line that wears a mark rather than a
                          glyph: it is what the thing looks like everywhere else
                          on the machine, and the colour earns its place by
                          saying so. */}
                      {item.id === 'siri' ? <SiriMark size={17} /> : <Icon name={item.icon} size={17} />}
                      <span className="side-label">{item.label}</span>
                      {/* Only Siri counts: it is the one line that is work
                          waiting rather than a place to go and look. */}
                      {item.id === 'siri' && captures.length > 0 && (
                        <span className="nav-count">{captures.length}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </nav>
          </Fragment>
        ))}
      </div>

      <motion.button
        whileTap={press}
        transition={spring}
        className="side-add"
        onClick={onAdd}
      >
        <Icon name="plus" size={17} strokeWidth={2.4} />
        <span className="side-label">Add transaction</span>
        <span className="side-kbd side-kbd-dark">
          <kbd>N</kbd>
        </span>
      </motion.button>

      <div className="side-foot">
        <button
          className={`nav-item ${route === 'settings' ? 'is-active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          {route === 'settings' && (
            <motion.span layoutId="nav-pill" className="nav-pill" transition={spring} />
          )}
          <span className="nav-content">
            <Icon name="settings" size={17} />
            <span className="side-label">Settings</span>
          </span>
        </button>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
        >
          <motion.span
            key={theme}
            initial={{ rotate: -70, opacity: 0, scale: 0.7 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            transition={spring}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} />
          </motion.span>
        </button>
      </div>
    </aside>
  );
}
