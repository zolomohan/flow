import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { RecordPicker } from '../components/RecordPicker';
import { TransactionRow } from '../components/TransactionRow';
import { Donut, SplitBar } from '../components/charts';
import { Button, Card, CardHead, Confirm, Empty } from '../components/ui';
import { useStore } from '../lib/store';
import { compactMoney, dayKey, dayLabel, money, shortDayLabel } from '../lib/format';
import { itemVariants, listVariants } from '../lib/motion';
import type { Folder, Paise, Transaction } from '../lib/types';

/** How many days a folder covers, both ends counted. */
function spanOf(first: string | null, last: string | null) {
  if (!first || !last) return 0;
  const days = Math.round(
    (new Date(last.slice(0, 10)).getTime() - new Date(first.slice(0, 10)).getTime()) / 86_400_000,
  );
  return days + 1;
}

/** One slice of what a folder was spent on. */
interface Slice {
  id: string;
  label: string;
  color: string;
  value: Paise;
}

/**
 * One folder, whole: what it came to, and everything in it.
 *
 * The figures at the top are the folder's own — read off the ledger by the
 * book, so they net refunds the way every other total does. The shape of it
 * is worked out here from the postings themselves, which is the only place
 * that knows a split bill was three categories rather than one.
 */
export function FolderDetail({
  folder, onBack, onEdit, onOpenTransaction, onSplitTransaction, onOweTransaction,
  onRefundTransaction,
}: {
  folder: Folder;
  onBack: () => void;
  onEdit: () => void;
  onOpenTransaction: (tx: Transaction) => void;
  onSplitTransaction: (tx: Transaction) => void;
  onOweTransaction: (tx: Transaction) => void;
  onRefundTransaction: (tx: Transaction) => void;
}) {
  const { listTransactions, revision, deleteFolder, addToFolder, removeFromFolder } = useStore();
  const [rows, setRows] = useState<Transaction[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Everything in it, in one read. A folder is a hand-gathered run rather
  // than a whole ledger, so it is asked for entire — the figures below are
  // about all of it, and half of it would make them lies.
  useEffect(() => {
    let live = true;
    setRows(null);
    listTransactions({ folderIds: [folder.id] })
      .then((next) => live && setRows(next))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [folder.id, revision, listTransactions]);

  const net = folder.income - folder.expense;
  // Which way the folder runs: a trip is what it cost, a folder of invoices
  // is what came in. Whichever side is larger is the one the page is about.
  const outward = folder.expense >= folder.income;
  const total = outward ? folder.expense : folder.income;
  const days = spanOf(folder.firstAt, folder.lastAt);

  // A folder of invoices is read the way a folder of a trip is, in the
  // direction it actually runs: the tiles below are about whichever side of
  // it carries the money, so an income folder is not four zeroes.
  const stats = useMemo(() => {
    const kind = outward ? 'expense' : 'income';
    // A refund is not money of its own: it comes off the posting it gives
    // back, exactly as the ledger's own totals read it.
    const side = (rows ?? []).filter((t) => t.kind === kind && !t.refundOf);
    const left = (t: Transaction) => t.amount - t.refunded;
    const biggest = side.reduce<Transaction | null>(
      (top, t) => (!top || left(t) > left(top) ? t : top),
      null,
    );
    const slices = new Map<string, Slice>();
    for (const t of side) {
      // A split bill belongs to every category it was filed under, in the
      // proportions it was cut into — and to whatever is left of it, so a
      // partly refunded bill counts for what it actually cost.
      const parts = t.splits.length
        ? t.splits.map((p) => ({
            id: p.categoryId ?? 'none',
            label: p.categoryName ?? 'Uncategorised',
            color: p.categoryColor ?? 'var(--ink-4)',
            value: t.amount ? Math.round(left(t) * (p.amount / t.amount)) : 0,
          }))
        : [{
            id: t.categoryId ?? 'none',
            label: t.categoryName ?? 'Uncategorised',
            color: t.categoryColor ?? 'var(--ink-4)',
            value: left(t),
          }];
      for (const part of parts) {
        const already = slices.get(part.id);
        if (already) already.value += part.value;
        else slices.set(part.id, { ...part });
      }
    }
    return {
      count: side.length,
      average: side.length ? Math.round(total / side.length) : 0,
      biggest,
      biggestAmount: biggest ? left(biggest) : 0,
      slices: [...slices.values()].sort((a, b) => b.value - a.value),
    };
  }, [rows, outward, total]);

  // A run that went on for months is better read as a rate than as a total,
  // and a fortnight's trip is not.
  const perMonth = days > 45 ? Math.round(total / (days / 30.44)) : 0;

  const grouped = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of rows ?? []) {
      const key = dayKey(tx.occurredAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(tx);
      else map.set(key, [tx]);
    }
    return [...map.entries()].map(([key, items]) => ({ key, items }));
  }, [rows]);

  const span =
    folder.firstAt && folder.lastAt
      ? days === 1
        ? shortDayLabel(folder.firstAt)
        : `${shortDayLabel(folder.firstAt)} → ${shortDayLabel(folder.lastAt)}`
      : 'nothing in it yet';

  return (
    <div className="screen folder-screen">
      <header className="screen-head detail-head">
        <div className="detail-id">
          <button className="detail-back" onClick={onBack} aria-label="Back to folders">
            <Icon name="chevron-left" size={17} />
          </button>
          <span className="folder-glyph is-large" style={{ ['--tint' as any]: folder.color }}>
            <Icon name={folder.icon} size={20} strokeWidth={2} />
          </span>
          <div>
            <h1>{folder.name}</h1>
            <p>
              {folder.count === 0
                ? 'Empty — add the entries it is about'
                : `${folder.count} ${folder.count === 1 ? 'entry' : 'entries'} · ${span}`}
              {folder.note && ` · ${folder.note}`}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <Button tone="ghost" icon="trash-2" onClick={() => setConfirming(true)}>
            Delete
          </Button>
          <Button icon="pencil" onClick={onEdit}>Edit</Button>
          <Button tone="primary" icon="plus" onClick={() => setAdding(true)}>
            Add entries
          </Button>
        </div>
      </header>

      {folder.count > 0 && (
        <Card className="folder-summary" padded={false}>
          <div className="folder-hero">
            <div>
              <span className="figure-label">{outward ? 'Spent' : 'Received'}</span>
              <BigMoney value={total} className="folder-hero-total" />
              <p className="folder-hero-sub">
                {folder.income > 0 && folder.expense > 0
                  ? `${money(Math.abs(net))} ${net >= 0 ? 'ahead' : 'out of pocket'} on it`
                  : days > 1
                    ? `over ${days} days`
                    : 'in a single day'}
              </p>
            </div>
            {folder.income > 0 && folder.expense > 0 && (
              <div className="folder-split">
                <SplitBar income={folder.income} expense={folder.expense} />
                <div className="folder-split-legend">
                  <span><i className="is-in" />In {money(folder.income)}</span>
                  <span><i className="is-out" />Out {money(folder.expense)}</span>
                </div>
              </div>
            )}
          </div>

          <div className="figure-row">
            <div className="figure">
              <span className="figure-label">Entries</span>
              <strong className="figure-value">{folder.count}</strong>
              <span className="figure-hint">
                {stats.count} {outward ? 'spent' : 'in'}
                {folder.transferred > 0 && ` · ${money(folder.transferred)} moved`}
              </span>
            </div>
            <div className="figure">
              <span className="figure-label">Average</span>
              <strong className="figure-value">{money(stats.average)}</strong>
              <span className="figure-hint">an entry</span>
            </div>
            <div className="figure">
              <span className="figure-label">Biggest</span>
              <strong className="figure-value">{money(stats.biggestAmount)}</strong>
              <span className="figure-hint">
                {stats.biggest
                  ? stats.biggest.merchant || stats.biggest.categoryName || 'one entry'
                  : '—'}
              </span>
            </div>
            <div className="figure">
              <span className="figure-label">{perMonth ? 'A month' : 'Span'}</span>
              <strong className="figure-value">
                {perMonth ? money(perMonth) : days ? `${days}d` : '—'}
              </strong>
              <span className="figure-hint">{span}</span>
            </div>
          </div>

          {stats.slices.length > 0 && (
            <div className="folder-breakdown">
              <Donut
                slices={stats.slices.slice(0, 8).map((s) => ({
                  id: s.id,
                  label: s.label,
                  value: s.value,
                  color: s.color,
                }))}
                size={150}
                thickness={18}
                centerLabel={outward ? 'Spent' : 'In'}
                centerValue={compactMoney(total)}
              />
              <ul className="folder-slices">
                {stats.slices.slice(0, 6).map((slice) => (
                  <li key={slice.id}>
                    <i style={{ background: slice.color }} />
                    <span className="folder-slice-name">{slice.label}</span>
                    <span className="folder-slice-bar">
                      <i
                        style={{
                          background: slice.color,
                          width: `${total ? (slice.value / total) * 100 : 0}%`,
                        }}
                      />
                    </span>
                    <strong>{money(slice.value)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <Card padded={false}>
        <div className="card-pad card-head-only">
          <CardHead
            title="What is in it"
            hint={
              rows === null
                ? 'Reading the ledger'
                : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`
            }
            action={
              rows && rows.length > 0 ? (
                <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
                  Add entries
                </Button>
              ) : undefined
            }
          />
        </div>

        {rows === null ? (
          <div className="plan-history-loading" />
        ) : rows.length === 0 ? (
          <div className="card-pad">
            <Empty
              icon="folder"
              title="Nothing in this folder yet"
              body="Pick the entries it is about out of the ledger — search, filter, tick as many as you like. They stay exactly where they are; the folder only holds their names."
              action={
                <Button tone="primary" icon="plus" onClick={() => setAdding(true)}>
                  Add entries
                </Button>
              }
            />
          </div>
        ) : (
          <motion.div
            className="ledger-days"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {grouped.map((day) => (
              <motion.section key={day.key} className="day-group" variants={itemVariants}>
                <header className="day-head">
                  <span>{dayLabel(day.key)}</span>
                </header>
                <div className="tx-list">
                  {day.items.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      onClick={() => onOpenTransaction(tx)}
                      onSplit={() => onSplitTransaction(tx)}
                      onDebt={() => onOweTransaction(tx)}
                      onRefund={() => onRefundTransaction(tx)}
                      extraActions={[
                        {
                          icon: 'folder-minus',
                          label: 'Take out of folder',
                          hint: 'the entry itself is untouched',
                          onClick: () => void removeFromFolder(folder.id, [tx.id]),
                        },
                      ]}
                    />
                  ))}
                </div>
              </motion.section>
            ))}
          </motion.div>
        )}
      </Card>

      <RecordPicker
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add to ${folder.name}`}
        subtitle="Tick everything this folder is about — the whole ledger is here, search and filters and all"
        pickLabel="Add"
        onPickMany={async (ids) => {
          setAdding(false);
          await addToFolder(folder.id, ids).catch(() => {});
        }}
      />

      <Confirm
        open={confirming}
        title={`Delete ${folder.name}?`}
        onConfirm={async () => {
          setConfirming(false);
          await deleteFolder(folder.id).catch(() => {});
          onBack();
        }}
        onCancel={() => setConfirming(false)}
      >
        {folder.count > 0
          ? `The ${folder.count} ${
              folder.count === 1 ? 'entry' : 'entries'
            } in it stay in the ledger exactly as they are — a folder holds names, not money.`
          : 'Nothing is in it.'}
      </Confirm>
    </div>
  );
}
