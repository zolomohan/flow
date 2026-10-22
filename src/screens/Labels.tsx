import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import {
  Button, Card, CardHead, Confirm, Empty, Field, Sheet, Switch, TextInput,
} from '../components/ui';
import { useStore } from '../lib/store';
import { itemVariants, listVariants } from '../lib/motion';
import type { Label } from '../lib/types';

/** The same palette categories pick from — labels sit beside them. */
const SWATCHES = [
  '#F2724F', '#42C251', '#118AE4', '#A855F7', '#F0B429', '#5A87E6',
  '#EC4899', '#8B5CF6', '#06B6D4', '#0EA5E9', '#14B8A6', '#676B89',
];

/**
 * Labels are pins, not filings: a posting keeps its account and category,
 * and a label sits on top for as long as it is useful — "Triage" on
 * unreviewed imports, or anything of your own. Deleting one takes it off
 * every posting it was pinned to and touches nothing else.
 *
 * A label can also be silent, which is the same pin kept to itself: it is
 * offered wherever you pin or filter, and drawn nowhere — no chip on the
 * row, none on the template. Some questions are worth asking often and not
 * worth reading a hundred times, and a ledger only has so much room.
 */
export function Labels({
  onOpenLabel,
}: {
  /** Opens the ledger filtered to one label. */
  onOpenLabel?: (labelId: string) => void;
}) {
  const { labels, deleteLabel } = useStore();
  // The label being worked on outlives the sheet's dismissal, so the form
  // keeps its content through the closing animation. `null` is a new one.
  const [editing, setEditing] = useState<Label | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // The label being asked about, held by id: the row it belongs to is still
  // there behind the dialog.
  const [confirming, setConfirming] = useState<string | null>(null);

  const open = (label: Label | null) => {
    setEditing(label);
    setSheetOpen(true);
  };

  const silent = labels.filter((l) => l.silent).length;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Labels</h1>
          <p>
            Tags you can put on any transaction and filter your ledger by. A silent
            one works the same way, but never shows on a row.
          </p>
        </div>
      </header>

      <Card padded={false}>
        <div className="card-pad card-head-only">
          <CardHead
            title={`${labels.length} ${labels.length === 1 ? 'label' : 'labels'}`}
            hint={silent > 0 ? `${silent} of them silent` : undefined}
            action={
              <Button size="sm" tone="primary" icon="plus" onClick={() => open(null)}>
                New label
              </Button>
            }
          />
        </div>
        {labels.length === 0 ? (
          <div className="card-pad">
            <Empty
              title="No labels yet"
              body="Tag any transaction, then filter your ledger by it."
            />
          </div>
        ) : (
          <motion.div className="label-list" variants={listVariants} initial="initial" animate="animate">
            {labels.map((label) => (
              <motion.div key={label.id} className="label-row" variants={itemVariants}>
                <span className="label-dot" style={{ background: label.color }} />
                <button
                  type="button"
                  className="label-name"
                  onClick={() => onOpenLabel?.(label.id)}
                  title={`Show the ${label.count} ${label.count === 1 ? 'transaction' : 'transactions'} wearing it`}
                >
                  <span className="label-name-line">
                    {label.name}
                    {label.silent && (
                      <span className="label-silent">
                        <Icon name="eye-off" size={10.5} strokeWidth={2.2} />
                        Silent
                      </span>
                    )}
                  </span>
                  <em>
                    {label.count} {label.count === 1 ? 'transaction' : 'transactions'}
                  </em>
                </button>
                <div className="label-actions">
                  <Button size="sm" tone="ghost" icon="pencil" onClick={() => open(label)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    tone="ghost"
                    icon="trash-2"
                    onClick={() => setConfirming(label.id)}
                  >
                    Delete
                  </Button>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </Card>

      <LabelSheet open={sheetOpen} editing={editing} onClose={() => setSheetOpen(false)} />

      <Confirm
        open={!!confirming}
        title="Delete this label?"
        onConfirm={async () => {
          const id = confirming;
          setConfirming(null);
          if (!id) return;
          if (editing?.id === id) setSheetOpen(false);
          await deleteLabel(id).catch(() => {});
        }}
        onCancel={() => setConfirming(null)}
      >
        {(() => {
          const going = labels.find((l) => l.id === confirming);
          if (!going) return 'The transactions wearing it stay; they simply stop wearing it.';
          return going.count > 0
            ? `${going.name} comes off the ${going.count} ${
                going.count === 1 ? 'transaction' : 'transactions'
              } wearing it. Nothing else about them changes.`
            : `${going.name} goes. Nothing is wearing it.`;
        })()}
      </Confirm>
    </div>
  );
}

/**
 * What a label is, asked in a sheet rather than in a panel above the list:
 * naming one is a small piece of work with an end to it, and the list it
 * belongs to stays where it was while you do it.
 */
function LabelSheet({
  open, editing, onClose,
}: {
  open: boolean;
  /** The label being changed, or null for one that doesn't exist yet. */
  editing: Label | null;
  onClose: () => void;
}) {
  const { labels, saveLabel } = useStore();
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [silent, setSilent] = useState(false);
  const [busy, setBusy] = useState(false);

  // How many labels the book has, held rather than watched: it is only the
  // opening colour's business, and saving one changes it — a form that read
  // it as it rendered would empty itself the moment it succeeded.
  const made = useRef(labels.length);
  useEffect(() => {
    made.current = labels.length;
  }, [labels.length]);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    // A new label comes up in a colour the book isn't already leaning on, so
    // one made in a hurry still comes out distinct from the rest.
    setColor(editing?.color ?? SWATCHES[made.current % SWATCHES.length]);
    setSilent(editing?.silent ?? false);
    setBusy(false);
  }, [open, editing]);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await saveLabel({ id: editing?.id ?? null, name: name.trim(), color, silent });
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
      title={editing ? 'Edit label' : 'New label'}
      subtitle={
        editing
          ? 'Renaming keeps it on every transaction wearing it'
          : 'A tag you can put on any transaction, and filter your ledger by'
      }
      width={430}
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
              {editing ? 'Save changes' : 'Add label'}
            </Button>
          </div>
        </>
      }
    >
      <div className="account-form">
        <div className="label-preview">
          <span className="tx-label" style={{ ['--tint' as any]: color }}>
            {name.trim() || 'Label'}
          </span>
        </div>

        <Field label="Name">
          <TextInput
            value={name}
            placeholder="What should it say?"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>

        <Field label="Colour">
          <div className="label-swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`label-swatch ${c === color ? 'is-on' : ''}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                onClick={() => setColor(c)}
              >
                {c === color && <Icon name="check" size={12} strokeWidth={3} />}
              </button>
            ))}
          </div>
        </Field>

        <Switch
          on={silent}
          onChange={setSilent}
          size="lg"
          label="Silent"
          hint={
            silent
              ? 'Filter by it, but never show it on a row'
              : 'Shows on every transaction wearing it'
          }
        />
      </div>
    </Sheet>
  );
}
