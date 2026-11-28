import { useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Icon, SiriMark } from '../components/Icon';
import { Button, Card, Empty, IconButton, Field, Segmented, Select, Sheet, Switch, TextArea, TextInput } from '../components/ui';
import type { SelectOption } from '../components/ui';
import { useStore } from '../lib/store';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { dayLabel, money, paiseToRupeeString, rupeesToPaise, timeLabel } from '../lib/format';
import type { Capture, CaptureImage, TransactionInput, TxKind } from '../lib/types';

const KINDS: { value: TxKind; label: string; icon: string; accent: string }[] = [
  { value: 'expense', label: 'Spent', icon: 'arrow-up-right', accent: '#F2724F' },
  { value: 'income', label: 'Received', icon: 'arrow-down-left', accent: '#42C251' },
  { value: 'transfer', label: 'Moved', icon: 'arrow-left-right', accent: '#118AE4' },
];

/** What a missing field is called where a person can read it. */
const MISSING: Record<string, string> = {
  amount: 'no figure',
  account: 'no account',
  destination: 'no destination',
  category: 'no category',
  reading: 'Claude is reading it',
  confirm: 'ready to confirm',
};

/**
 * Everything said out loud, in two halves.
 *
 * **Waiting** is what the book refused to guess at: an amount it could not
 * read, or an account nobody marked, which is the one thing it will not
 * invent. A capture that resolved cleanly never lands here — it is already in
 * the ledger, because a sentence you have to come back to the Mac to approve
 * is not much better than writing it down yourself.
 *
 * **History** is everything that did go in. Each row keeps the words beside
 * what they became, and reads the figures off the posting rather than off
 * what was heard — correct the transaction and the record of it follows.
 */
export function Siri({ onOpenTransaction }: { onOpenTransaction?: (id: string) => void }) {
  const { captures, captureHistory, lastCaptureSync, syncCaptures } = useStore();
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      await syncCaptures();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="screen has-fold">
      <header className="screen-head">
        <div>
          <h1>Inbox</h1>
          <p>Say, type or show a transaction, and Claude logs it.</p>
        </div>
        <div className="head-actions">
          <Button tone="secondary" icon="refresh-cw" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      </header>

      <LogBox />

      {captures.length === 0 ? (
        <Empty
          screen
          art="inbox"
          tone="green"
          title="Nothing waiting"
          body={
            lastCaptureSync
              ? 'Everything you have said so far is in your ledger.'
              : 'Point a Shortcut at the drop file, then dictate a transaction.'
          }
        />
      ) : (
        <motion.div
          className="capture-list"
          variants={listVariants}
          initial="initial"
          animate="animate"
        >
          {captures.map((capture) => (
            <CaptureRow key={capture.id} capture={capture} />
          ))}
        </motion.div>
      )}

      {/* Everything that did land, folded away at the foot of the screen. A
          tab made the two halves equals, which they are not: what is waiting
          is work, and what went in is a record you look up. */}
      <History
        rows={captureHistory}
        onOpenTransaction={onOpenTransaction}
        // Only when something above it is not already claiming the space. An
        // empty state fills the screen on its own, and a spacer growing
        // beside it splits the room between them — which reads as the words
        // sitting too high rather than as the fold sitting too low.
        spacer={captures.length > 0}
      />
    </div>
  );
}

/** Where the capture auto mode switch is kept in the book. */
const CAPTURE_AUTO = 'capture_auto';

/** Reads a picked file as base64, without the data: prefix. */
function readImage(file: File): Promise<CaptureImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type || 'image/jpeg', data: url.slice(url.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Type a sentence, paste a bank SMS or attach a screenshot, and Claude reads
 * it. The same path the Log transaction action will take from Siri, the
 * share sheet and the Watch, so it can be tried here first.
 */
function LogBox() {
  const { logCapture, settings, saveSetting } = useStore();
  const auto = settings[CAPTURE_AUTO] !== '0';
  const [text, setText] = useState('');
  const [image, setImage] = useState<{ name: string; data: CaptureImage } | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setImage({ name: file.name, data: await readImage(file) });
  };

  const send = async () => {
    if (busy || (!text.trim() && !image)) return;
    setBusy(true);
    try {
      await logCapture(text.trim() || null, image?.data ?? null);
      setText('');
      setImage(null);
    } catch {
      /* said in a toast; the words stay so they can be sent again */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="log-box">
      <TextArea
        value={text}
        placeholder="450 at Swiggy on HDFC, or paste a bank SMS"
        aria-label="What to log"
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="log-box-foot">
        <input
          ref={picker}
          type="file"
          accept="image/*,application/pdf"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button tone="secondary" icon="paperclip" onClick={() => picker.current?.click()} disabled={busy}>
          {image ? image.name : 'Attach'}
        </Button>
        {image && (
          <IconButton icon="x" label="Remove picture" onClick={() => setImage(null)} disabled={busy} />
        )}
        <span className="log-box-auto" title="When Claude is sure, log it without asking">
          <Switch on={auto} onChange={(on) => saveSetting(CAPTURE_AUTO, on ? '1' : '0')} label="Auto-log" size="md" />
        </span>
        <Button tone="primary" icon="sparkles" onClick={send} disabled={busy || (!text.trim() && !image)}>
          {busy ? 'Reading…' : 'Log'}
        </Button>
      </div>
    </Card>
  );
}

/**
 * What was said, and what it became.
 *
 * The words lead each row rather than the figures: the ledger already lists
 * the postings, and the only thing this view can tell you that the ledger
 * cannot is which sentence turned into which line — and whether it heard you
 * right.
 */
function History({
  rows,
  onOpenTransaction,
  spacer = true,
}: {
  rows: Capture[];
  onOpenTransaction?: (id: string) => void;
  /** Whether the fold has to push itself to the foot of the screen. */
  spacer?: boolean;
}) {
  // Held by id rather than by value: the list refreshes under the sheet on
  // every sync, and a copy taken when it opened would go stale in place.
  const [showing, setShowing] = useState<string | null>(null);
  const capture = rows.find((r) => r.id === showing) ?? null;

  const [open, setOpen] = useState(false);
  // Nothing said yet is not worth a fold saying so — the screen above it
  // already has an empty state, and two of them is the screen apologising.
  if (rows.length === 0) return null;

  return (
    <>
      {/* The empty page between the list and the fold, so a screen with
          little waiting still holds the fold at its foot. Opening winds it
          back to nothing and walks the row up to the list above. */}
      <motion.div
        className="fold-gap"
        initial={false}
        animate={{ flexGrow: open || !spacer ? 0 : 1 }}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        aria-hidden
      />

      <section className="fold">
        <button
          type="button"
          className={`fold-head ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
        >
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
            <Icon name="chevron-right" size={15} />
          </motion.span>
          <strong>History</strong>
          <span className="fold-count">
            {rows.length} {rows.length === 1 ? 'capture' : 'captures'}
          </span>
          <em>latest {dayLabel(rows[0].capturedAt)}</em>
        </button>

        <motion.div
          className="fold-body"
          initial={false}
          // The list is in the page either way, so `auto` is a height that
          // can actually be measured when the fold is asked to open.
          animate={{ height: open ? 'auto' : 0 }}
          transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
          // Shut, it is still in the page: nothing inside should answer a Tab
          // or be read out to anyone.
          aria-hidden={!open}
          inert={!open}
        >
          <div className="fold-inner">
    <Card padded={false}>
      <motion.div
        className="spoken-list"
        variants={listVariants}
        initial="initial"
        animate="animate"
      >
        {rows.map((row) => (
          <motion.div key={row.id} className="spoken-item" variants={itemVariants}>
            <button
              type="button"
              className="spoken-row"
              onClick={() => setShowing(row.id)}
              title="What was said, and what it became"
            >
              {/* Three columns, one job each: what the posting is, what it
                  came to, and the words that made it. */}
              <span className="spoken-dot" style={{ background: row.categoryColor ?? 'var(--ink-4)' }}>
                <Icon name={row.categoryIcon ?? 'circle-dashed'} size={12} />
              </span>
              <span className="spoken-what">
                <strong>{row.merchant || row.categoryName || 'Unfiled'}</strong>
                <span className="spoken-meta">
                  {[row.accountName, row.categoryName].filter(Boolean).join(' · ') || '—'}
                </span>
              </span>
              <span className="spoken-said">“{row.said}”</span>
              <span className="spoken-figures">
                <strong className={row.kind === 'income' ? 'is-in' : ''}>
                  {row.kind === 'income' ? '+' : ''}
                  {money(row.amount)}
                </strong>
                <span className="spoken-meta">{dayLabel(row.capturedAt)}</span>
              </span>
            </button>
          </motion.div>
        ))}
      </motion.div>

      <Sheet
        open={!!capture}
        onClose={() => setShowing(null)}
        title={capture?.merchant || 'Capture'}
        subtitle={capture ? `${dayLabel(capture.capturedAt)} · ${timeLabel(capture.capturedAt)}` : undefined}
        footer={
          capture?.transactionId && onOpenTransaction ? (
            <Button
              tone="primary"
              icon="arrow-up-right"
              onClick={() => {
                const id = capture.transactionId!;
                setShowing(null);
                onOpenTransaction(id);
              }}
            >
              Open the transaction
            </Button>
          ) : undefined
        }
      >
        {capture && (
          <div className="spoken-detail">
            <section>
              <h4>Said</h4>
              <p className="spoken-quote">“{capture.said}”</p>
            </section>
            <section>
              <h4>What it became</h4>
              <dl className="spoken-facts">
                <dt>Amount</dt>
                <dd>{money(capture.amount)}</dd>
                <dt>Kind</dt>
                <dd>{capture.kind ?? '—'}</dd>
                <dt>Account</dt>
                <dd>{capture.accountName ?? '—'}</dd>
                {capture.toAccountName && (
                  <>
                    <dt>Into</dt>
                    <dd>{capture.toAccountName}</dd>
                  </>
                )}
                <dt>Category</dt>
                <dd>
                  {capture.categoryName
                    ? `${capture.categoryGroupName ? `${capture.categoryGroupName} › ` : ''}${capture.categoryName}`
                    : '—'}
                </dd>
                <dt>Merchant</dt>
                <dd>{capture.merchant || '—'}</dd>
                {capture.note && (
                  <>
                    <dt>Note</dt>
                    <dd>{capture.note}</dd>
                  </>
                )}
              </dl>
            </section>
            <section>
              <h4>As it arrived</h4>
              {/* Pretty-printed where it parses, and shown untouched where it
                  does not — a line the book could not read is exactly the one
                  worth seeing raw. */}
              <pre className="spoken-json">{pretty(capture.raw) || 'Not recorded for this capture.'}</pre>
            </section>
          </div>
        )}
      </Sheet>
    </Card>
          </div>
        </motion.div>
      </section>
    </>
  );
}

/** JSON laid out to be read, or the text as it stands if it is not JSON. */
function pretty(raw: string) {
  const text = raw.trim();
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * One sentence, and the form that finishes it. The words sit above the fields
 * rather than behind them: what was actually said is the only thing that can
 * settle an argument with a bad reading, and it is what you check the fields
 * against before letting them into the book.
 */
function CaptureRow({ capture }: { capture: Capture }) {
  const { accounts, categories, postCapture, dismissCapture } = useStore();
  const [kind, setKind] = useState<TxKind>(capture.kind ?? 'expense');
  const [amount, setAmount] = useState(
    capture.amount > 0 ? paiseToRupeeString(capture.amount) : '',
  );
  const [accountId, setAccountId] = useState(capture.accountId);
  const [toAccountId, setToAccountId] = useState(capture.toAccountId);
  const [categoryId, setCategoryId] = useState(capture.categoryId);
  const [merchant, setMerchant] = useState(capture.merchant);
  const [busy, setBusy] = useState(false);

  const live = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const accountOptions: SelectOption[] = live.map((a) => ({
    value: a.id,
    label: a.name,
    hint: a.institution ?? undefined,
    icon: a.icon,
    color: a.color,
  }));

  // Groups stay headings; only what sits under one can be filed against.
  const categoryOptions: SelectOption[] = useMemo(() => {
    const palette = categories.filter((c) => c.kind === (kind === 'income' ? 'income' : 'expense'));
    return palette
      .filter((c) => !c.parentId)
      .flatMap((top) => {
        const children = palette.filter((c) => c.parentId === top.id);
        return [
          {
            value: top.id,
            label: top.name,
            icon: top.icon,
            color: top.color,
            heading: children.length > 0,
          } as SelectOption,
          ...children.map<SelectOption>((child) => ({
            value: child.id,
            label: child.name,
            icon: child.icon,
            color: child.color,
            child: true,
            under: top.name,
          })),
        ];
      });
  }, [categories, kind]);

  const paise = rupeesToPaise(amount);
  const ready = paise > 0 && !!accountId && (kind !== 'transfer' || !!toAccountId);

  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const input: TransactionInput = {
        id: null,
        kind,
        amount: paise,
        accountId: accountId!,
        toAccountId: kind === 'transfer' ? toAccountId : null,
        categoryId: kind === 'transfer' ? null : categoryId,
        merchant: merchant.trim(),
        note: capture.note,
        // The day it was spoken about, not the day you got round to it.
        occurredAt: capture.occurredAt ?? new Date().toISOString().slice(0, 16),
        splits: null,
        shares: null,
        labelIds: null,
        refundOf: null,
      };
      await postCapture(capture.id, input);
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.article className="capture" variants={itemVariants}>
      <header className="capture-head">
        <span className="capture-said">
          {capture.source === 'siri' ? <SiriMark size={14} /> : <Icon name="pencil" size={14} />}
          “{capture.said}”
        </span>
        <span className="capture-when">
          {dayLabel(capture.capturedAt)} · {timeLabel(capture.capturedAt)}
        </span>
      </header>

      {capture.unresolved.length > 0 && (
        <p className="capture-missing">
          Waiting on {capture.unresolved.map((w) => MISSING[w] ?? w).join(', ')}.
        </p>
      )}

      <div className="capture-form">
        <Segmented options={KINDS} value={kind} onChange={setKind} size="sm" name={capture.id} />
        <Field label="Amount">
          <TextInput
            value={amount}
            inputMode="decimal"
            placeholder="0"
            autoFocus={capture.amount === 0}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </Field>
        <Field label={kind === 'transfer' ? 'Out of' : 'Account'}>
          <Select
            options={accountOptions}
            value={accountId}
            onChange={setAccountId}
            placeholder="Which account?"
            searchable
          />
        </Field>
        {kind === 'transfer' ? (
          <Field label="Into">
            <Select
              options={accountOptions.filter((o) => o.value !== accountId)}
              value={toAccountId}
              onChange={setToAccountId}
              placeholder="Which account?"
              searchable
            />
          </Field>
        ) : (
          <Field label="Category">
            <Select
              options={categoryOptions}
              value={categoryId}
              onChange={setCategoryId}
              placeholder="Unfiled"
              allowClear
              searchable
            />
          </Field>
        )}
        <Field label={kind === 'transfer' ? 'Note' : 'Merchant'}>
          <TextInput
            value={merchant}
            placeholder="Who it was with"
            onChange={(e) => setMerchant(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </Field>
      </div>

      <footer className="capture-actions">
        <Button size="sm" tone="ghost" icon="x" onClick={() => dismissCapture(capture.id)}>
          Dismiss
        </Button>
        <Button size="sm" tone="primary" icon="check" onClick={add} disabled={!ready || busy}>
          Add to ledger
        </Button>
      </footer>
    </motion.article>
  );
}
