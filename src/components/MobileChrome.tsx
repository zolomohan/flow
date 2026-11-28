/**
 * The shell a phone gets instead of the sidebar.
 *
 * The sidebar holds sixteen destinations down one edge, which is a shape a
 * 390pt window does not have. A tab bar holds five, so the question is not
 * how to shrink the sidebar but which five the phone is *for* — and the
 * answer follows from what a phone is for at all. It is where money is
 * caught, not where a year is reconciled: Overview to see where things
 * stand, Transactions to find one, capture in the middle where a thumb
 * already is, Siri for the sentences waiting to be filed, and More for the
 * eleven screens that are reading rather than doing.
 *
 * Nothing is unreachable. More is the sidebar's own list with the four tabs
 * taken out of it, in the sidebar's own order.
 */

import { AnimatePresence, motion } from 'motion/react';
import { Icon, SiriMark } from './Icon';
import { NAV, type Route } from './Sidebar';
import { Sheet } from './ui';
import { OWNER_FALLBACK, OWNER_NAME, useStore } from '../lib/store';
import { money } from '../lib/format';
import { press, spring } from '../lib/motion';

/** The destinations that earn a slot of their own. Order is left to right. */
const TABS: { id: Route; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'transactions', label: 'Ledger', icon: 'list-filter' },
  { id: 'siri', label: 'Inbox', icon: 'sparkles' },
];

const TAB_IDS = new Set<Route>(TABS.map((t) => t.id));

/**
 * The bar across the top: where you have been, whose book this is, and the
 * way into search.
 *
 * It stands where the Mac's title bar does and clears the status bar the same
 * way, which is the one piece of luck in the port — `--titlebar-h` was always
 * a band of chrome nothing may be drawn under, and iOS has one of those too.
 */
export function MobileBar({
  onBack, onForward, canBack, canForward, onSearch,
}: {
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onSearch: () => void;
}) {
  const { overview, settings } = useStore();
  const owner = settings[OWNER_NAME]?.trim() || OWNER_FALLBACK;

  return (
    <header className="mobile-bar">
      <motion.button
        whileTap={canBack ? press : undefined}
        transition={spring}
        className="mobile-bar-btn"
        onClick={onBack}
        disabled={!canBack}
        aria-label="Back"
      >
        <Icon name="chevron-left" size={20} strokeWidth={2.2} />
      </motion.button>

      {/* Forward has no gesture behind it — the edge swipe only goes one way —
          so it appears when there is somewhere to go and takes no room at all
          when there is not. */}
      <AnimatePresence initial={false}>
        {canForward && (
          <motion.button
            key="fwd"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 34 }}
            exit={{ opacity: 0, width: 0 }}
            transition={spring}
            whileTap={press}
            className="mobile-bar-btn"
            onClick={onForward}
            aria-label="Forward"
          >
            <Icon name="chevron-right" size={20} strokeWidth={2.2} />
          </motion.button>
        )}
      </AnimatePresence>

      <div className="mobile-bar-id">
        <strong>{owner}</strong>
        <span>{overview ? money(overview.netWorth) : '—'}</span>
      </div>

      <motion.button
        whileTap={press}
        transition={spring}
        className="mobile-bar-btn"
        onClick={onSearch}
        aria-label="Search"
      >
        <Icon name="search" size={19} />
      </motion.button>
    </header>
  );
}

/**
 * The bar across the bottom. Four destinations and the one thing a phone is
 * carried around to do, which sits in the middle because that is where a
 * thumb rests — and is drawn as a filled disc rather than a fifth glyph,
 * since it goes somewhere no back button returns from.
 */
export function TabBar({
  route, onNavigate, onAdd, onMore, moreOpen,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  onAdd: () => void;
  onMore: () => void;
  moreOpen: boolean;
}) {
  const { captures } = useStore();
  // More is lit by whatever is on screen as much as by being open: a screen
  // reached through it is still a screen that lives behind it.
  const moreActive = moreOpen || !TAB_IDS.has(route);

  return (
    <nav className="tab-bar" aria-label="Sections">
      {TABS.slice(0, 2).map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === route && !moreOpen}
          onClick={() => onNavigate(tab.id)}
        />
      ))}

      <motion.button
        whileTap={press}
        transition={spring}
        className="tab-add"
        onClick={onAdd}
        aria-label="Add transaction"
      >
        <Icon name="plus" size={23} strokeWidth={2.5} />
      </motion.button>

      <TabButton
        tab={TABS[2]}
        active={TABS[2].id === route && !moreOpen}
        count={captures.length}
        onClick={() => onNavigate(TABS[2].id)}
      />

      <TabButton
        tab={{ id: 'settings', label: 'More', icon: 'grid-2x2' }}
        active={moreActive}
        onClick={onMore}
      />
    </nav>
  );
}

function TabButton({
  tab, active, count = 0, onClick,
}: {
  tab: { id: Route; label: string; icon: string };
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      <span className="tab-glyph">
        {tab.id === 'siri' ? <SiriMark size={21} /> : <Icon name={tab.icon} size={21} />}
        {count > 0 && <span className="tab-count">{count > 99 ? '99+' : count}</span>}
      </span>
      <span className="tab-label">{tab.label}</span>
    </button>
  );
}

/**
 * Everything the tab bar could not hold, as a sheet rather than a screen:
 * picking from it is a step sideways, and a page you have to come back out of
 * would put a screen between you and the one you asked for.
 */
export function MoreSheet({
  open, onClose, route, onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  route: Route;
  onNavigate: (route: Route) => void;
}) {
  const { theme, toggleTheme } = useStore();
  const rest = NAV.filter((item) => !TAB_IDS.has(item.id));

  const go = (next: Route) => {
    onNavigate(next);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="More" width={520}>
      <div className="more-grid">
        {rest.map((item) => (
          <button
            key={item.id}
            className={`more-tile ${item.id === route ? 'is-active' : ''}`}
            onClick={() => go(item.id)}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="more-foot">
        <button
          className={`more-tile is-wide ${route === 'settings' ? 'is-active' : ''}`}
          onClick={() => go('settings')}
        >
          <Icon name="settings" size={20} />
          <span>Settings</span>
        </button>
        <button className="more-tile is-wide" onClick={toggleTheme}>
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={20} />
          <span>{theme === 'light' ? 'Dark' : 'Light'}</span>
        </button>
      </div>
    </Sheet>
  );
}
