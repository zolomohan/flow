import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, CardHead, Empty, TextInput } from '../components/ui';
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
 */
export function Labels({
  onOpenLabel,
}: {
  /** Opens the ledger filtered to one label. */
  onOpenLabel?: (labelId: string) => void;
}) {
  const { labels, saveLabel, deleteLabel } = useStore();
  const [editing, setEditing] = useState<Label | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A delete armed and then abandoned disarms itself.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const startEdit = (label: Label) => {
    setEditing(label);
    setName(label.name);
    setColor(label.color);
  };

  const clear = () => {
    setEditing(null);
    setName('');
    setColor(SWATCHES[0]);
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await saveLabel({ id: editing?.id ?? null, name: name.trim(), color });
      clear();
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Labels</h1>
          <p>Pins on top of postings — a filing lives in categories, a label is temporary by nature.</p>
        </div>
      </header>

      <Card>
        <CardHead
          title={editing ? `Editing “${editing.name}”` : 'New label'}
          hint={editing ? 'Renaming keeps it on every posting it is pinned to' : undefined}
        />
        <div className="label-form">
          <TextInput
            value={name}
            placeholder="What should it say?"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
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
          <div className="label-form-actions">
            {editing && (
              <Button tone="ghost" onClick={clear} disabled={busy}>
                Cancel
              </Button>
            )}
            <Button tone="primary" icon={editing ? 'check' : 'plus'} onClick={submit} disabled={!name.trim() || busy}>
              {editing ? 'Save changes' : 'Add label'}
            </Button>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        {labels.length === 0 ? (
          <div className="card-pad">
            <Empty
              icon="bookmark"
              title="No labels yet"
              body="Make one above — or import a statement, which pins Triage on whatever needs a look."
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
                  title={`Show the ${label.count} ${label.count === 1 ? 'posting' : 'postings'} wearing it`}
                >
                  {label.name}
                  <em>
                    {label.count} {label.count === 1 ? 'transaction' : 'transactions'}
                  </em>
                </button>
                <div className="label-actions">
                  <Button size="sm" tone="ghost" icon="pencil" onClick={() => startEdit(label)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    tone={confirming === label.id ? 'danger' : 'ghost'}
                    icon="trash-2"
                    onClick={async () => {
                      if (confirming !== label.id) return setConfirming(label.id);
                      setConfirming(null);
                      if (editing?.id === label.id) clear();
                      await deleteLabel(label.id).catch(() => {});
                    }}
                  >
                    {confirming === label.id ? 'Sure?' : 'Delete'}
                  </Button>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </Card>
    </div>
  );
}
