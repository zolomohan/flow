import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { Amount } from './Money';
import { useStore } from '../lib/store';
import { accountWorth, dayLabel, money } from '../lib/format';
import { sheetBackdrop, sheetPanel, spring } from '../lib/motion';
import type { Transaction, TxKind } from '../lib/types';
import type { Route } from './Sidebar';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  tint?: string;
  section: string;
  run: () => void;
}

export function CommandPalette({
  open, onClose, onNavigate, onNewTransaction, onOpenTransaction,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (route: Route) => void;
  onNewTransaction: (kind: TxKind) => void;
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { accounts, listTransactions, toggleTheme } = useStore();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setMatches([]);
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  // Debounced so keystrokes don't each hit SQLite.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) {
      setMatches([]);
      return;
    }
    const timer = window.setTimeout(() => {
      listTransactions({ search: term, limit: 6 })
        .then(setMatches)
        .catch(() => setMatches([]));
    }, 130);
    return () => window.clearTimeout(timer);
  }, [query, open, listTransactions]);

  const commands = useMemo<Command[]>(() => {
    const actions: Command[] = [
      { id: 'new-expense', label: 'New expense', icon: 'arrow-up-right', section: 'Actions', run: () => onNewTransaction('expense') },
      { id: 'new-income', label: 'New income', icon: 'arrow-down-left', tint: 'var(--green)', section: 'Actions', run: () => onNewTransaction('income') },
      { id: 'new-transfer', label: 'New transfer', icon: 'arrow-left-right', tint: 'var(--blue)', section: 'Actions', run: () => onNewTransaction('transfer') },
      { id: 'go-overview', label: 'Go to Overview', icon: 'layout-dashboard', section: 'Navigate', run: () => onNavigate('overview') },
      { id: 'go-transactions', label: 'Go to Transactions', icon: 'list-filter', section: 'Navigate', run: () => onNavigate('transactions') },
      { id: 'go-accounts', label: 'Go to Accounts', icon: 'wallet-cards', section: 'Navigate', run: () => onNavigate('accounts') },
      { id: 'go-debts', label: 'Go to Debts', icon: 'arrow-left-right', section: 'Navigate', run: () => onNavigate('debts') },
      { id: 'go-investments', label: 'Go to Investments', icon: 'coins', section: 'Navigate', run: () => onNavigate('investments') },
      { id: 'go-insights', label: 'Go to Insights', icon: 'sparkles', section: 'Navigate', run: () => onNavigate('insights') },
      { id: 'go-settings', label: 'Go to Settings', icon: 'settings', section: 'Navigate', run: () => onNavigate('settings') },
      { id: 'theme', label: 'Toggle light / dark', icon: 'moon', section: 'Navigate', run: toggleTheme },
    ];

    const term = query.trim().toLowerCase();
    const filteredActions = term
      ? actions.filter((a) => a.label.toLowerCase().includes(term))
      : actions.slice(0, 4);

    const accountMatches: Command[] = (term
      ? accounts.filter((a) => a.name.toLowerCase().includes(term))
      : []
    ).map((a) => ({
      id: `acct-${a.id}`,
      label: a.name,
      hint: money(accountWorth(a)),
      icon: a.icon,
      tint: a.color,
      section: 'Accounts',
      run: () => onNavigate('accounts'),
    }));

    const txMatches: Command[] = matches.map((tx) => ({
      id: `tx-${tx.id}`,
      label: tx.merchant || (tx.categoryName ?? 'Transaction'),
      hint: dayLabel(tx.occurredAt),
      icon: tx.categoryIcon ?? 'arrow-left-right',
      tint: tx.categoryColor ?? tx.accountColor,
      section: 'Transactions',
      run: () => onOpenTransaction(tx),
    }));

    return [...filteredActions, ...accountMatches, ...txMatches];
  }, [query, accounts, matches, onNavigate, onNewTransaction, onOpenTransaction, toggleTheme]);

  useEffect(() => setCursor(0), [query]);

  const fire = (command: Command) => {
    command.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % Math.max(1, commands.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + commands.length) % Math.max(1, commands.length));
    } else if (e.key === 'Enter' && commands[cursor]) {
      e.preventDefault();
      fire(commands[cursor]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  let lastSection = '';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="scrim scrim-top"
          variants={sheetBackdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            className="palette"
            variants={sheetPanel}
            initial="initial"
            animate="animate"
            exit="exit"
            onKeyDown={onKeyDown}
          >
            <div className="palette-input">
              <Icon name="search" size={17} />
              <input
                ref={inputRef}
                value={query}
                placeholder="Search transactions, accounts, or jump anywhere…"
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>esc</kbd>
            </div>
            <div className="palette-list">
              {commands.length === 0 && (
                <p className="palette-empty">Nothing matches “{query}”.</p>
              )}
              {commands.map((command, i) => {
                const header = command.section !== lastSection ? command.section : null;
                lastSection = command.section;
                return (
                  <div key={command.id}>
                    {header && <div className="palette-section">{header}</div>}
                    <button
                      className={`palette-item ${i === cursor ? 'is-cursor' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => fire(command)}
                    >
                      {i === cursor && (
                        <motion.span
                          layoutId="palette-cursor"
                          className="palette-cursor"
                          transition={spring}
                        />
                      )}
                      <span
                        className="palette-glyph"
                        style={{ ['--tint' as any]: command.tint ?? 'var(--ink-3)' }}
                      >
                        <Icon name={command.icon} size={15} />
                      </span>
                      <span className="palette-label">{command.label}</span>
                      {command.hint && <span className="palette-hint">{command.hint}</span>}
                      {command.section === 'Transactions' && (
                        <Amount
                          value={matches.find((m) => `tx-${m.id}` === command.id)?.amount ?? 0}
                          kind={matches.find((m) => `tx-${m.id}` === command.id)?.kind}
                        />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
