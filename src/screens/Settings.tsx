import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, CardHead, Segmented, type SegmentOption } from '../components/ui';
import { REQUIRE_NOTE, useStore } from '../lib/store';
import { spring } from '../lib/motion';

type Tab = 'preferences' | 'data';

const TABS: SegmentOption<Tab>[] = [
  { value: 'preferences', label: 'Preferences', icon: 'settings' },
  { value: 'data', label: 'Your data', icon: 'download' },
];

const BLURBS: Record<Tab, string> = {
  preferences: 'How Midas looks, and what it asks of you while you use it.',
  data: 'The SQLite file on this Mac, and what you can do to it.',
};


export function Settings() {
  const [tab, setTab] = useState<Tab>('preferences');

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Settings</h1>
          <p>{BLURBS[tab]}</p>
        </div>
      </header>

      <div className="settings-tabs">
        <Segmented options={TABS} value={tab} onChange={setTab} name="settings-tab" />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          className="settings-panel"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16 }}
        >
          {tab === 'preferences' && <PreferencesPanel />}
          {tab === 'data' && <DataPanel />}
        </motion.div>
      </AnimatePresence>

      <p className="colophon">
        Midas · local-first expense tracking · SQLite + Tauri
      </p>
    </div>
  );
}

function PreferencesPanel() {
  const { theme, toggleTheme, settings, saveSetting } = useStore();
  const requireNote = settings[REQUIRE_NOTE] === '1';
  return (
    <>
    <Card>
      <CardHead title="Theme" hint="Midas follows whichever you pick" />
      <div className="theme-row">
        {(['light', 'dark'] as const).map((option) => (
          <button
            key={option}
            className={`theme-card ${theme === option ? 'is-active' : ''} theme-${option}`}
            onClick={() => { if (theme !== option) toggleTheme(); }}
          >
            <span className="theme-preview">
              <i /><i /><i />
            </span>
            <span className="theme-name">
              {option === 'light' ? 'Light' : 'Dark'}
              {theme === option && (
                <motion.span layoutId="theme-check" transition={spring}>
                  <Icon name="check" size={14} />
                </motion.span>
              )}
            </span>
          </button>
        ))}
      </div>
    </Card>

    <Card>
      <CardHead
        title="Entering transactions"
        hint="A new entry can’t be saved without a note. What is already in the book is left as it is."
      />
      <button
        type="button"
        className={`settle-toggle ${requireNote ? 'is-on' : ''}`}
        onClick={() => saveSetting(REQUIRE_NOTE, requireNote ? '0' : '1')}
      >
        <span className="settle-box">{requireNote && <Icon name="check" size={12} />}</span>
        Ask for a note on every new transaction
        <small>{requireNote ? 'on' : 'off'}</small>
      </button>
    </Card>
    </>
  );
}

/* ------------------------------------------------------------------- Data */

function DataPanel() {
  const { seedDemo, resetAll } = useStore();
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  return (
    <Card>
      <CardHead title="Your data" hint="Everything lives in a local SQLite file on this Mac" />
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>Load the sample book</strong>
            <p>Replaces everything with eight months of realistic history.</p>
          </div>
          <Button icon="sparkles" onClick={() => seedDemo()}>Load sample</Button>
        </div>
        <div className="data-row">
          <div>
            <strong>Start from scratch</strong>
            <p>Clears every account and transaction. This cannot be undone.</p>
          </div>
          <Button
            tone="danger"
            icon="trash-2"
            onClick={() => {
              if (!confirmReset) return setConfirmReset(true);
              resetAll();
              setConfirmReset(false);
            }}
          >
            {confirmReset ? 'Tap again to erase' : 'Clear everything'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------- Category sheet */
