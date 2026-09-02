import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { FOLDER_ICON_GROUPS, Icon } from '../components/Icon';
import {
  Button, Card, Empty, Field, Sheet, TextArea, TextInput,
} from '../components/ui';
import { useStore } from '../lib/store';
import { FolderDetail } from './FolderDetail';
import { money, shortDayLabel } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Folder, Transaction } from '../lib/types';

/** The palette categories and labels pick from — folders sit beside them. */
const SWATCHES = [
  '#F2724F', '#42C251', '#118AE4', '#A855F7', '#F0B429', '#5A87E6',
  '#EC4899', '#8B5CF6', '#06B6D4', '#0EA5E9', '#14B8A6', '#676B89',
];

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
  const { folders } = useStore();
  // Held by id: the store hands back fresh folders after every write, and the
  // open page should follow them rather than go stale behind a save.
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Folder | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const open = (folder: Folder | null) => {
    setEditing(folder);
    setSheetOpen(true);
  };

  const viewing = openId ? folders.find((f) => f.id === openId) ?? null : null;
  const held = folders.reduce((sum, f) => sum + f.count, 0);

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
                  : 'Entries kept together because they belong together — a trip, a move, a project.'}
              </p>
            </div>
            <div className="head-actions">
              <Button tone="primary" icon="plus" onClick={() => open(null)}>
                New folder
              </Button>
            </div>
          </header>

          {folders.length === 0 ? (
            <Card>
              <Empty
                icon="folder"
                title="No folders yet"
                body="A folder holds the entries you say belong together, whatever they are filed under. Make one for the trip you are on and gather the flights, the hotel and the dinners into it — the ledger keeps them where they are, and the folder adds them up."
                action={
                  <Button tone="primary" icon="plus" onClick={() => open(null)}>
                    New folder
                  </Button>
                }
              />
            </Card>
          ) : (
            <motion.div
              className="folder-grid"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {folders.map((folder) => {
                const net = folder.income - folder.expense;
                const outward = folder.expense >= folder.income;
                return (
                  <motion.button
                    key={folder.id}
                    type="button"
                    className="folder-card"
                    style={{ ['--tint' as any]: folder.color }}
                    variants={itemVariants}
                    whileTap={{ scale: 0.99 }}
                    transition={spring}
                    onClick={() => setOpenId(folder.id)}
                  >
                    <span className="folder-card-top">
                      <span className="folder-glyph" style={{ ['--tint' as any]: folder.color }}>
                        <Icon name={folder.icon} size={17} strokeWidth={2} />
                      </span>
                      <span className="folder-card-name">
                        {folder.name}
                        <em>
                          {folder.count === 0
                            ? 'empty'
                            : `${folder.count} ${folder.count === 1 ? 'entry' : 'entries'}`}
                          {folder.firstAt && folder.lastAt && (
                            <>
                              {' · '}
                              {folder.firstAt.slice(0, 10) === folder.lastAt.slice(0, 10)
                                ? shortDayLabel(folder.firstAt)
                                : `${shortDayLabel(folder.firstAt)} → ${shortDayLabel(folder.lastAt)}`}
                            </>
                          )}
                        </em>
                      </span>
                      <Icon name="chevron-right" size={16} />
                    </span>

                    <span className="folder-card-figures">
                      <span className="folder-card-total">
                        {money(outward ? folder.expense : folder.income)}
                        <em>{outward ? 'spent' : 'received'}</em>
                      </span>
                      {folder.income > 0 && folder.expense > 0 && (
                        <span className={`folder-card-net ${net >= 0 ? 'is-up' : ''}`}>
                          {money(net, { sign: net > 0 })}
                          <em>net</em>
                        </span>
                      )}
                    </span>

                    {folder.note && <span className="folder-card-note">{folder.note}</span>}
                  </motion.button>
                );
              })}
            </motion.div>
          )}
        </div>
      )}

      <FolderSheet open={sheetOpen} editing={editing} onClose={() => setSheetOpen(false)} />
    </>
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
          : 'A place to gather the entries one thing is made of'
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
            <em>{note.trim() || (editing ? 'no note' : 'what it is for, if it needs saying')}</em>
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
            placeholder="What it is for, when the name doesn’t say it"
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
