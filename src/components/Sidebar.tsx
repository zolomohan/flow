import { motion } from 'motion/react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { money } from '../lib/format';
import { press, spring } from '../lib/motion';

export type Route =
  | 'overview'
  | 'transactions'
  | 'planned'
  | 'debts'
  | 'investments'
  | 'insights'
  | 'accounts'
  | 'cards'
  | 'categories'
  | 'labels'
  | 'templates'
  | 'settings';

/** The day's work first, then the two lists the rest of it is filed against. */
const NAV: { id: Route; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'transactions', label: 'Transactions', icon: 'list-filter' },
  { id: 'planned', label: 'Planned', icon: 'repeat' },
  { id: 'debts', label: 'Debts', icon: 'arrow-left-right' },
  { id: 'investments', label: 'Investments', icon: 'coins' },
  { id: 'insights', label: 'Insights', icon: 'sparkles' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet-cards' },
  { id: 'cards', label: 'Cards', icon: 'credit-card' },
  { id: 'categories', label: 'Categories', icon: 'tags' },
  { id: 'labels', label: 'Labels', icon: 'bookmark' },
  { id: 'templates', label: 'Templates', icon: 'shapes' },
];

export function Sidebar({
  route, onNavigate, onAdd, onSearch,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  onAdd: () => void;
  onSearch: () => void;
}) {
  const { overview, theme, toggleTheme } = useStore();

  return (
    <aside className="sidebar">
      {/* Keeps the traffic lights clear of the brand mark. */}
      <div className="titlebar-drag" data-tauri-drag-region />

      <div className="brand">
        <span className="brand-mark">M</span>
        <div className="brand-text">
          <strong>Midas</strong>
          <span>{overview ? money(overview.netWorth) : '—'}</span>
        </div>
      </div>

      <button className="side-search" onClick={onSearch}>
        <Icon name="search" size={15} />
        Search
        <span className="side-kbd">
          <kbd>⌘</kbd>
          <kbd>K</kbd>
        </span>
      </button>

      <nav className="nav">
        {NAV.map((item) => {
          const active = item.id === route;
          return (
            <button
              key={item.id}
              className={`nav-item ${active ? 'is-active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              {active && (
                <motion.span layoutId="nav-pill" className="nav-pill" transition={spring} />
              )}
              <span className="nav-content">
                <Icon name={item.icon} size={17} />
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <motion.button
        whileTap={press}
        transition={spring}
        className="side-add"
        onClick={onAdd}
      >
        <Icon name="plus" size={17} strokeWidth={2.4} />
        Add transaction
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
            Settings
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
