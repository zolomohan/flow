import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon, SiriMark } from '../components/Icon';
import { Button, Card, Empty, Field, Segmented, Select, Sheet, TextInput } from '../components/ui';
import type { SelectOption } from '../components/ui';
import { useStore } from '../lib/store';
import { itemVariants, listVariants } from '../lib/motion';
import { dayLabel, money, paiseToRupeeString, rupeesToPaise, timeLabel } from '../lib/format';
import type { Capture, TransactionInput, TxKind } from '../lib/types';

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
};

type Tab = 'waiting' | 'history';

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
export function Siri({
  onShowInLedger,
  onOpenTransaction,
}: {
  /** Opens the ledger filtered to the Siri label. */
  onShowInLedger?: () => void;
  onOpenTransaction?: (id: string) => void;
}) {
  const { captures, captureHistory, lastCaptureSync, syncCaptures } = useStore();
  const [checking, setChecking] = useState(false);
  const [tab, setTab] = useState<Tab>('waiting');

  const check = async () => {
    setChecking(true);
    try {
      await syncCaptures();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Siri</h1>
          <p>Said out loud — what landed, and what needs a hand.</p>
        </div>
        <div className="head-actions">
          {onShowInLedger && (
            <Button tone="ghost" icon="bookmark" onClick={onShowInLedger}>
              Show in ledger
            </Button>
          )}
          <Button tone="secondary" icon="refresh-cw" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      </header>

      <Segmented
        options={[
          {
            value: 'waiting' as Tab,
            label: captures.length > 0 ? `Waiting (${captures.length})` : 'Waiting',
            icon: 'inbox',
          },
          { value: 'history' as Tab, label: 'History', icon: 'check-check' },
        ]}
        value={tab}
        onChange={setTab}
        name="siri-tab"
      />

      {tab === 'history' ? (
        <History rows={captureHistory} onOpenTransaction={onOpenTransaction} />
      ) : captures.length === 0 ? (
        <Card>
          <Empty
            icon="inbox"
            title="Nothing waiting"
            body={
              lastCaptureSync
                ? 'Every capture so far went straight into the ledger — look under History. Say another one to your phone and it will be here when iCloud catches up.'
                : 'Point a Shortcut at the drop file below and dictate a transaction to it.'
            }
          />
        </Card>
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

    </div>
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
}: {
  rows: Capture[];
  onOpenTransaction?: (id: string) => void;
}) {
  // Held by id rather than by value: the list refreshes under the sheet on
  // every sync, and a copy taken when it opened would go stale in place.
  const [showing, setShowing] = useState<string | null>(null);
  const capture = rows.find((r) => r.id === showing) ?? null;

  if (rows.length === 0) {
    return (
      <Card>
        <Empty
          icon="check-check"
          title="Nothing said yet"
          body="Dictate a transaction to your phone. Once it lands in the ledger it is listed here, alongside the words that made it."
        />
      </Card>
    );
  }
  return (
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
              Open the posting
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
