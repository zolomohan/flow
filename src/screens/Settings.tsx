import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import {
  Button, Card, CardHead, Confirm, Segmented, Switch, TextInput,
  type SegmentOption,
} from '../components/ui';
import { open, save } from '@tauri-apps/plugin-dialog';
import { api } from '../lib/api';
import {
  HIDE_AMOUNTS, OWNER_FALLBACK, OWNER_NAME, REQUIRE_NOTE, THEMES, useStore,
} from '../lib/store';
import { spring } from '../lib/motion';

type Tab = 'preferences' | 'data';

const TABS: SegmentOption<Tab>[] = [
  { value: 'preferences', label: 'Preferences', icon: 'settings' },
  { value: 'data', label: 'Your data', icon: 'download' },
];

const BLURBS: Record<Tab, string> = {
  preferences: 'How Midas looks, and what it asks of you while you use it.',
  data: 'Your name, the SQLite file on this Mac, and what you can do to it.',
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
    </div>
  );
}

function PreferencesPanel() {
  const { theme, setTheme, settings, saveSetting } = useStore();
  const requireNote = settings[REQUIRE_NOTE] === '1';
  const hideAmounts = settings[HIDE_AMOUNTS] === '1';
  return (
    <>
    <Card>
      <CardHead title="Theme" hint="Midas follows whichever you pick" />
      <div className="theme-row">
        {THEMES.map((option) => (
          <button
            key={option.value}
            className={`theme-card ${theme === option.value ? 'is-active' : ''} theme-${option.value}`}
            onClick={() => setTheme(option.value)}
          >
            <span className="theme-preview">
              <i /><i /><i />
            </span>
            <span className="theme-name">
              {option.label}
              {theme === option.value && (
                <motion.span layoutId="theme-check" transition={spring}>
                  <Icon name="check" size={14} />
                </motion.span>
              )}
            </span>
            <span className="theme-hint">{option.hint}</span>
          </button>
        ))}
      </div>
    </Card>

    <Card className="setting-card">
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>Ask for a note</strong>
            <p>
              A new transaction can’t be saved without one. What is already in
              the book is left as it is.
            </p>
          </div>
          <Switch
            size="lg"
            ariaLabel="Ask for a note"
            on={requireNote}
            onChange={(next) => saveSetting(REQUIRE_NOTE, next ? '1' : '0')}
          />
        </div>

        <div className="data-row">
          <div>
            <strong>Hide amounts</strong>
            <p>
              Every figure on every screen comes out as the shape of itself —
              <strong className="setting-sample"> ₹•,••,•••</strong> — with the
              words around it left readable. For a desk somebody walks past, or
              a screen you are sharing. Nothing in the book changes, and what
              you are typing is never hidden from you.
            </p>
          </div>
          <Switch
            size="lg"
            ariaLabel="Hide amounts"
            on={hideAmounts}
            onChange={(next) => saveSetting(HIDE_AMOUNTS, next ? '1' : '0')}
          />
        </div>
      </div>
    </Card>
    </>
  );
}

/* ------------------------------------------------------------------- Data */

/**
 * The name the sidebar wears. Held here while it is being typed and written
 * down once it is done: a book should not take a trip through SQLite for
 * every letter.
 */
function NameCard() {
  const { settings, saveSetting } = useStore();
  const saved = settings[OWNER_NAME] ?? '';
  const [name, setName] = useState(saved);

  // The book is read in after this screen is first drawn, so the field takes
  // what was stored the moment it arrives.
  useEffect(() => setName(saved), [saved]);

  const commit = () => {
    const next = name.trim();
    setName(next);
    if (next !== saved) saveSetting(OWNER_NAME, next);
  };

  return (
    <Card className="setting-card">
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>Name</strong>
            <p>What the app calls you.</p>
          </div>
          <TextInput
            className="name-input"
            value={name}
            placeholder={OWNER_FALLBACK}
            maxLength={40}
            aria-label="Your name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </div>
      </div>
    </Card>
  );
}

function DataPanel() {
  const { resetAll, toast } = useStore();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const exportBook = async () => {
    const to = await save({
      title: 'Where should the copy go?',
      defaultPath: `midas-${today}.sqlite3`,
      filters: [{ name: 'Midas book', extensions: ['sqlite3'] }],
    });
    if (!to) return;
    setBusy('export');
    try {
      await api.exportBook(to);
      toast(`Copied to ${to.split('/').pop()}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const importBook = async () => {
    const from = await open({
      title: 'Which book should be read in?',
      multiple: false,
      directory: false,
      filters: [{ name: 'Midas book', extensions: ['sqlite3', 'db', 'sqlite'] }],
    });
    if (typeof from !== 'string') return;
    setBusy('import');
    try {
      const kept = await api.importBook(from);
      toast(`Book replaced · the old one is beside it as ${kept.split('/').pop()}`);
      // Everything on screen is from the book that has just been replaced.
      window.location.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <NameCard />

    <Card>
      <CardHead title="Your data" hint="Everything lives in a local SQLite file on this Mac" />
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>Save a copy</strong>
            <p>
              The whole book in one file — accounts, ledger, debts, holdings and
              prices. Written whole rather than copied, so nothing is left in the log.
            </p>
          </div>
          <Button icon="download" onClick={exportBook} disabled={busy !== null}>
            {busy === 'export' ? 'Saving…' : 'Save a copy'}
          </Button>
        </div>
        <div className="data-row">
          <div>
            <strong>Read a book in</strong>
            <p>
              Replaces everything here with a copy saved earlier. What is here now is
              kept beside the file you choose, in case it was the wrong one.
            </p>
          </div>
          <Button icon="corner-up-left" onClick={importBook} disabled={busy !== null}>
            {busy === 'import' ? 'Reading…' : 'Read one in'}
          </Button>
        </div>
        <div className="data-row">
          <div>
            <strong>Start from scratch</strong>
            <p>Clears every account and transaction. This cannot be undone.</p>
          </div>
          <Button
            tone="danger"
            icon="trash-2"
            disabled={busy !== null}
            onClick={() => setConfirmReset(true)}
          >
            Clear everything
          </Button>
        </div>
      </div>

      <Confirm
        open={confirmReset}
        title="Erase everything in this book?"
        confirmLabel="Erase it all"
        onConfirm={() => {
          setConfirmReset(false);
          resetAll();
        }}
        onCancel={() => setConfirmReset(false)}
      >
        Every account, transaction, debt, holding and plan goes, and the book
        opens empty. This cannot be undone — save a copy first if there is
        anything in it worth keeping.
      </Confirm>
    </Card>
    </>
  );
}
