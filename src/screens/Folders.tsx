import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { FOLDER_ICON_GROUPS, Icon } from '../components/Icon';
import {
  Button, Empty, Field, Segmented, Sheet, TextArea, TextInput,
  type SegmentOption,
} from '../components/ui';
import { useStore } from '../lib/store';
import { FolderDetail } from './FolderDetail';
import { countedAmount, dateRangeLabel, isCashbackCredit, money } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Folder, Paise, Transaction } from '../lib/types';

/** The palette categories and labels pick from — folders sit beside them. */
const SWATCHES = [
  '#F2724F', '#42C251', '#118AE4', '#A855F7', '#F0B429', '#5A87E6',
  '#EC4899', '#8B5CF6', '#06B6D4', '#0EA5E9', '#14B8A6', '#676B89',
];

/**
 * How the folders are laid out. Most of them are a stretch of time — a trip,
 * a move, a course of treatment — so the newest goes first and each year is
 * a heading; the other two are for finding one by size or by name.
 */
type FolderSort = 'recent' | 'biggest' | 'name';
const SORTS: SegmentOption<FolderSort>[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'biggest', label: 'Biggest' },
  { value: 'name', label: 'A–Z' },
];
const SORT_KEY = 'midas.folders.sort';

/** One share of what a folder went on, by the top-level category. */
interface Share {
  id: string;
  name: string;
  color: string;
  value: Paise;
}

/** Whichever side a folder runs on: a trip is what it cost, a folder of
 *  invoices what came in. */
const outward = (f: Folder) => f.expense >= f.income;
const totalOf = (f: Folder) => (outward(f) ? f.expense : f.income);
/** When it was last touched: its newest entry, or when it was made. */
const lastOf = (f: Folder) => f.lastAt ?? f.createdAt;

/**
 * Folders: postings kept together because they belong together.
 *
 * A category files a posting and a label marks it. A folder holds it — by
 * hand, for as long as the thing it is about is going on. The Goa trip, the
 * kitchen, a year of one client's invoices: runs of spending that cut across
 * every category and account the book has, and that no rule could gather,
 * because the only thing they have in common is that you say so.
 *
 * Nothing is copied. A folder keeps names, so correcting a posting corrects
 * what the folder says about it, and a posting can sit in as many folders as
 * you like — a flight to Goa is both the trip and the year's travel.
 */
export function Folders({
  onOpenTransaction, onSplitTransaction, onOweTransaction, onRefundTransaction,
}: {
  onOpenTransaction: (tx: Transaction) => void;
  onSplitTransaction: (tx: Transaction) => void;
  onOweTransaction: (tx: Transaction) => void;
  onRefundTransaction: (tx: Transaction) => void;
}) {
  const { folders, categories, listTransactions, revision } = useStore();
  // Held by id: the store hands back fresh folders after every write, and the
  // open page should follow them rather than go stale behind a save.
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Folder | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Remembered on this machine only: an order is how you like to look, not
  // something the book needs to know.
  const [sort, setSort] = useState<FolderSort>(() => {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      return saved === 'biggest' || saved === 'name' ? saved : 'recent';
    } catch {
      return 'recent';
    }
  });
  const chooseSort = (next: FolderSort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* the order still changes, it just won't be remembered */
    }
  };

  const open = (folder: Folder | null) => {
    setEditing(folder);
    setSheetOpen(true);
  };

  const viewing = openId ? folders.find((f) => f.id === openId) ?? null : null;
  const held = folders.reduce((sum, f) => sum + f.count, 0);

  // Everything in any folder, in one read, for what each one went on. It is a
  // few hundred postings at most, and asking per folder would be one read per
  // card.
  const ids = folders.map((f) => f.id).join(',');
  const [inside, setInside] = useState<Transaction[]>([]);
  useEffect(() => {
    if (!ids) return setInside([]);
    let live = true;
    listTransactions({ folderIds: ids.split(',') })
      .then((rows) => live && setInside(rows))
      .catch(() => live && setInside([]));
    return () => {
      live = false;
    };
  }, [ids, revision, listTransactions]);

  // Each folder's money by top-level category, read the way its own page
  // reads it: on the side it runs, net of refunds, a split bill across every
  // category it was cut into.
  const shares = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const group = (groupId: string | null, categoryId: string | null) => {
      const c = byId.get(groupId ?? categoryId ?? '');
      return c
        ? { id: c.id, name: c.name, color: c.color }
        : { id: 'none', name: 'Uncategorised', color: 'var(--ink-4)' };
    };
    const side = new Map(folders.map((f) => [f.id, outward(f) ? 'expense' : 'income']));
    const out = new Map<string, Map<string, Share>>();
    for (const t of inside) {
      if (t.refundOf || isCashbackCredit(t)) continue;
      const left = countedAmount(t);
      const parts = t.splits.length
        ? t.splits.map((p) => ({
            ...group(p.categoryGroupId, p.categoryId),
            value: t.amount ? Math.round(left * (p.amount / t.amount)) : 0,
          }))
        : [{ ...group(t.categoryGroupId, t.categoryId), value: left }];
      for (const f of t.folders) {
        if (side.get(f.id) !== t.kind) continue;
        const into = out.get(f.id) ?? new Map<string, Share>();
        out.set(f.id, into);
        for (const part of parts) {
          const had = into.get(part.id);
          if (had) had.value += part.value;
          else into.set(part.id, { ...part });
        }
      }
    }
    return new Map(
      [...out.entries()].map(([id, m]) => [id, [...m.values()].sort((a, b) => b.value - a.value)]),
    );
  }, [inside, folders, categories]);

  const sections = useMemo(() => {
    const list = [...folders];
    if (sort === 'biggest') {
      list.sort((a, b) => totalOf(b) - totalOf(a) || a.name.localeCompare(b.name));
      return [{ key: 'all', year: null, folders: list }];
    }
    if (sort === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return [{ key: 'all', year: null, folders: list }];
    }
    list.sort((a, b) => lastOf(b).localeCompare(lastOf(a)));
    const years = new Map<string, Folder[]>();
    for (const f of list) {
      const year = lastOf(f).slice(0, 4);
      years.set(year, [...(years.get(year) ?? []), f]);
    }
    return [...years.entries()].map(([year, items]) => ({ key: year, year, folders: items }));
  }, [folders, sort]);

  return (
    <>
      {viewing ? (
        <FolderDetail
          folder={viewing}
          onBack={() => setOpenId(null)}
          onEdit={() => open(viewing)}
          onOpenTransaction={onOpenTransaction}
          onSplitTransaction={onSplitTransaction}
          onOweTransaction={onOweTransaction}
          onRefundTransaction={onRefundTransaction}
        />
      ) : (
        <div className="screen">
          <header className="screen-head">
            <div>
              <h1>Folders</h1>
              <p>
                {folders.length
                  ? `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'} · ${held} ${
                      held === 1 ? 'entry' : 'entries'
                    } gathered`
                  : 'Group the transactions that belong together: a trip, a move, a project.'}
              </p>
            </div>
            <div className="head-actions">
              {folders.length > 1 && (
                <Segmented options={SORTS} value={sort} onChange={chooseSort} name="folder-sort" />
              )}
              <Button tone="primary" icon="plus" onClick={() => open(null)}>
                New folder
              </Button>
            </div>
          </header>

          {folders.length === 0 ? (
            <Empty
              screen
              art="folder"
              tone="violet"
              title="No folders yet"
              body="Group the transactions that belong together: a trip, a move, a project."
            />
          ) : (
            // Keyed on the order, so changing it lays the cards out afresh
            // rather than sliding twenty of them past each other.
            <div key={sort} className="folder-sections">
              {sections.map((section) => {
                return (
                  <section key={section.key} className="folder-section">
                    {section.year && (
                      <header className="folder-section-head">
                        <h2>{section.year}</h2>
                        <span>
                          {section.folders.length} {section.folders.length === 1 ? 'folder' : 'folders'}
                        </span>
                      </header>
                    )}
                    <motion.div
                      className="folder-grid"
                      variants={listVariants}
                      initial="initial"
                      animate="animate"
                    >
                      {section.folders.map((folder) => (
                        <FolderCard
                          key={folder.id}
                          folder={folder}
                          shares={shares.get(folder.id) ?? []}
                          // Under a year's heading the year is already said.
                          withYear={!section.year}
                          onOpen={() => setOpenId(folder.id)}
                        />
                      ))}
                    </motion.div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      )}

      <FolderSheet open={sheetOpen} editing={editing} onClose={() => setSheetOpen(false)} />
    </>
  );
}

/**
 * One folder, read at a glance: what it is, when, how much, and what the
 * money went on. The figure needs no word under it — a trip is what it cost —
 * and the strip under the figure is the folder's own breakdown in miniature,
 * so a fortnight of hotels and a month of furniture look like what they are.
 */
function FolderCard({
  folder, shares, withYear, onOpen,
}: {
  folder: Folder;
  shares: Share[];
  withYear: boolean;
  onOpen: () => void;
}) {
  const about =
    folder.count === 0 || !folder.firstAt || !folder.lastAt
      ? 'Nothing in it yet'
      : [
          dateRangeLabel(folder.firstAt, folder.lastAt, withYear),
          `${folder.count} ${folder.count === 1 ? 'entry' : 'entries'}`,
        ]
          .filter(Boolean)
          .join(' · ');
  const whole = shares.reduce((sum, s) => sum + s.value, 0);
  const total = totalOf(folder);

  return (
    <motion.button
      type="button"
      className="folder-card"
      style={{ ['--tint' as any]: folder.color }}
      title={folder.name}
      variants={itemVariants}
      whileTap={{ scale: 0.99 }}
      transition={spring}
      onClick={onOpen}
    >
      <span className="folder-card-top">
        <span className="folder-glyph" style={{ ['--tint' as any]: folder.color }}>
          <Icon name={folder.icon} size={17} strokeWidth={2} />
        </span>
        <span className="folder-card-name">
          <b>{folder.name}</b>
          <em>{about}</em>
        </span>
        <Icon name="chevron-right" size={16} />
      </span>

      {folder.count > 0 && (
        <span className="folder-card-body">
          <span className={`folder-card-total ${outward(folder) ? '' : 'is-up'}`}>
            {outward(folder) ? money(total) : money(total, { sign: true })}
          </span>
          <span className="folder-strip" aria-hidden="true">
            {whole > 0 &&
              shares
                .filter((s) => s.value > 0)
                .map((s) => (
                  <i key={s.id} style={{ flexGrow: s.value, background: s.color }} />
                ))}
          </span>
          {whole > 0 && (
            <span className="folder-strip-legend">
              {shares.slice(0, 2).map((s) => (
                <span key={s.id}>
                  <i style={{ background: s.color }} />
                  {s.name} {Math.round((s.value / whole) * 100)}%
                </span>
              ))}
            </span>
          )}
        </span>
      )}

      {folder.note && <span className="folder-card-note">{folder.note}</span>}
    </motion.button>
  );
}

/**
 * What a folder is called, what it looks like, and what it is for. The last
 * of those is optional and usually left out: "Goa" needs no explaining three
 * months later, and "Kitchen" sometimes does.
 */
function FolderSheet({
  open, editing, onClose,
}: {
  open: boolean;
  /** The folder being changed, or null for one that doesn't exist yet. */
  editing: Folder | null;
  onClose: () => void;
}) {
  const { folders, saveFolder } = useStore();
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [icon, setIcon] = useState('folder');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How many folders the book has, held rather than watched: it is only the
  // opening colour's business, and saving one changes it.
  const made = useRef(folders.length);
  useEffect(() => {
    made.current = folders.length;
  }, [folders.length]);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setColor(editing?.color ?? SWATCHES[made.current % SWATCHES.length]);
    setIcon(editing?.icon ?? 'folder');
    setNote(editing?.note ?? '');
    setError(null);
    setBusy(false);
  }, [open, editing]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError('A folder needs a name.');
    setBusy(true);
    try {
      await saveFolder({
        id: editing?.id ?? null,
        name: trimmed,
        color,
        icon,
        note: note.trim() || null,
      });
      onClose();
    } catch {
      // The store has already said what went wrong; stay put so the name can
      // be fixed rather than typed again.
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit folder' : 'New folder'}
      subtitle={
        editing
          ? 'Renaming it keeps everything in it'
          : 'Group the transactions that belong together'
      }
      width={520}
      footer={
        <>
          <span />
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button
              tone="primary"
              icon={editing ? 'check' : 'plus'}
              disabled={!name.trim() || busy}
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Add folder'}
            </Button>
          </div>
        </>
      }
    >
      <div className="account-form">
        <div className="folder-preview">
          <span className="folder-glyph is-large" style={{ ['--tint' as any]: color }}>
            <Icon name={icon} size={20} strokeWidth={2} />
          </span>
          <span className="folder-preview-name">
            {name.trim() || 'Folder name'}
            <em>{note.trim() || (editing ? 'no note' : 'what it is for')}</em>
          </span>
        </div>

        <Field label="Name" error={error}>
          <TextInput
            value={name}
            autoFocus
            placeholder="Goa, March"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>

        <Field label="Note" hint="optional">
          <TextArea
            value={note}
            placeholder="What it is for"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <div>
          <span className="field-label">Colour</span>
          <div className="swatch-row">
            {SWATCHES.map((s) => (
              <motion.button
                key={s}
                type="button"
                whileTap={{ scale: 0.9 }}
                className={`swatch-pick ${s === color ? 'is-active' : ''}`}
                style={{ background: s }}
                onClick={() => setColor(s)}
                aria-label={`Colour ${s}`}
              >
                {s === color && (
                  <motion.span layoutId="folder-swatch-ring" className="swatch-ring" transition={spring} />
                )}
              </motion.button>
            ))}
          </div>
        </div>

        <div>
          <span className="field-label">Icon</span>
          <div className="icon-shelves">
            {FOLDER_ICON_GROUPS.map((shelf) => (
              <div key={shelf.label} className="icon-shelf">
                <span className="icon-shelf-label">{shelf.label}</span>
                <div className="icon-row">
                  {shelf.icons.map((option) => (
                    <motion.button
                      key={option}
                      type="button"
                      whileTap={{ scale: 0.92 }}
                      className={`icon-pick ${option === icon ? 'is-active' : ''}`}
                      style={option === icon ? ({ ['--pick' as any]: color }) : undefined}
                      onClick={() => setIcon(option)}
                      aria-label={option}
                    >
                      <Icon name={option} size={17} />
                    </motion.button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
