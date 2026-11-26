import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import {
  Button, Card, CardHead, Confirm, Segmented, Switch, TextInput,
  type SegmentOption,
} from '../components/ui';
import { open, save } from '@tauri-apps/plugin-dialog';
import { api } from '../lib/api';
import type { AiStatus } from '../lib/types';
import {
  HIDE_AMOUNTS, OWNER_FALLBACK, OWNER_NAME, REQUIRE_NOTE, THEMES, useStore,
} from '../lib/store';
import { spring } from '../lib/motion';

type Tab = 'preferences' | 'claude' | 'data';

const TABS: SegmentOption<Tab>[] = [
  { value: 'preferences', label: 'Preferences', icon: 'settings' },
  { value: 'claude', label: 'Claude', icon: 'sparkles' },
  { value: 'data', label: 'Your data', icon: 'download' },
];

const BLURBS: Record<Tab, string> = {
  preferences: 'How flow looks and behaves.',
  claude: 'How flow reaches Claude to read your statements and answer questions on Ask.',
  data: 'Your name, and a copy of your book to keep, restore or clear.',
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
          {tab === 'claude' && <ClaudePanel />}
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
      <CardHead title="Theme" hint="Light, dark, or whatever your Mac is set to" />
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
              New transactions can’t be saved without one. Existing ones are
              left as they are.
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
              Every figure on screen becomes
              <strong className="setting-sample"> ₹•,••,•••</strong>. Nothing in
              your book changes, and what you type stays visible to you.
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

/**
 * The connection to Claude. Anthropic has no "Sign in with Claude" for an
 * app like this one, so there are two ways in: borrow the sign-in of
 * Anthropic's own CLI, which keeps no secret in flow at all, or paste an API
 * key, which goes into the macOS Keychain. The sign-in wins when both are
 * there.
 */
function ClaudePanel() {
  const { toast } = useStore();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'check' | 'save' | 'forget' | 'test' | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  const refresh = async () => {
    setBusy('check');
    setTested(null);
    try {
      setStatus(await api.aiStatus());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const saveKey = async () => {
    setBusy('save');
    try {
      await api.aiSaveKey(key);
      setKey('');
      toast('Key saved to the Keychain');
      setStatus(await api.aiStatus());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const forgetKey = async () => {
    setBusy('forget');
    try {
      await api.aiForgetKey();
      toast('Key removed from the Keychain');
      setStatus(await api.aiStatus());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setTested(null);
    try {
      const model = await api.aiTest();
      setTested(`Connected · ${model}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const using =
    status?.source === 'ant'
      ? 'your Anthropic sign-in'
      : status?.source === 'keychain'
        ? 'the API key in your Keychain'
        : status?.source === 'env'
          ? 'ANTHROPIC_API_KEY from the environment'
          : null;

  return (
    <>
    <Card>
      <CardHead
        title="Connection"
        hint={
          status === null
            ? 'Checking…'
            : using
              ? `Using ${using}`
              : 'Not connected'
        }
      />
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>
              <span className={`ai-dot ${using ? 'is-on' : ''}`} />
              {using ? 'Ready for statements and Ask' : 'Claude isn\'t connected'}
            </strong>
            <p>
              {tested ??
                (status
                  ? `Statements and questions on Ask go to ${status.model}. Usage is billed to the Anthropic Console account you connect, not to a claude.ai plan.`
                  : 'Looking for a sign-in or a key…')}
            </p>
          </div>
          <div className="ai-settings-actions">
            <Button icon="refresh-cw" tone="ghost" onClick={refresh} disabled={busy !== null}>
              {busy === 'check' ? 'Checking…' : 'Check again'}
            </Button>
            <Button icon="shield-check" onClick={test} disabled={busy !== null || !using}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
          </div>
        </div>
      </div>
    </Card>

    <Card>
      <CardHead title="Sign in with Anthropic" hint="Recommended · no key stored in flow" />
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>
              {status?.antSignedIn
                ? 'Signed in'
                : status?.antPath
                  ? 'The Anthropic CLI is installed, but not signed in'
                  : 'The Anthropic CLI isn\'t installed'}
            </strong>
            <p>
              {status?.antSignedIn
                ? `flow asks ant for a short-lived token each time it reads. The sign-in runs out after some weeks; run ant auth login again when it does.`
                : status?.antProblem ??
                  'flow can use the sign-in of Anthropic\'s own command-line tool, so you approve access in your browser instead of pasting a key.'}
            </p>
            {!status?.antSignedIn && (
              <ol className="ai-howto">
                {!status?.antPath && (
                  <li>
                    In Terminal: <code>brew install anthropics/tap/ant</code>
                  </li>
                )}
                <li>
                  Then: <code>ant auth login</code>, and approve in the browser tab that
                  opens
                </li>
                <li>Come back here and choose Check again</li>
              </ol>
            )}
          </div>
        </div>
      </div>
    </Card>

    <Card>
      <CardHead title="Or use an API key" hint="Kept in the macOS Keychain" />
      <div className="data-actions">
        {status?.hasKey ? (
          <div className="data-row">
            <div>
              <strong>A key is saved</strong>
              <p>
                {status.antSignedIn
                  ? 'Your sign-in is used first; the key is the fallback when it runs out.'
                  : 'flow reads statements with this key.'}
              </p>
            </div>
            <Button tone="danger" icon="trash-2" onClick={forgetKey} disabled={busy !== null}>
              {busy === 'forget' ? 'Removing…' : 'Remove key'}
            </Button>
          </div>
        ) : (
          <div className="data-row ai-key-row">
            <div>
              <strong>Paste a key</strong>
              <p>
                Create one at platform.claude.com under API keys. It never leaves this
                Mac except to talk to Anthropic.
              </p>
            </div>
            <form
              className="ai-key-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void saveKey();
              }}
            >
              <TextInput
                type="password"
                value={key}
                placeholder="sk-ant-…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button tone="primary" icon="key-round" type="submit" disabled={busy !== null || !key.trim()}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </Button>
            </form>
          </div>
        )}
      </div>
    </Card>
    </>
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
      filters: [{ name: 'flow book', extensions: ['sqlite3'] }],
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
      filters: [{ name: 'flow book', extensions: ['sqlite3', 'db', 'sqlite'] }],
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
      <CardHead title="Your data" hint="Everything stays on this Mac" />
      <div className="data-actions">
        <div className="data-row">
          <div>
            <strong>Save a copy</strong>
            <p>
              Your whole book in one file: accounts, transactions, debts and
              holdings.
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
              Replaces everything here with a copy you saved earlier. Your current
              book is kept alongside it as a backup.
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
        Every account, transaction, debt, holding and plan is deleted. This
        cannot be undone. Save a copy first.
      </Confirm>
    </Card>
    </>
  );
}
