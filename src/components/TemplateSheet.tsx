import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { AskPicker } from './AskPicker';
import { Button, Field, Sheet, TextInput } from './ui';
import { useStore } from '../lib/store';
import { money } from '../lib/format';
import { askableFor, templateToInput } from '../lib/templates';
import type { TemplateField, TxTemplate } from '../lib/types';

/**
 * What a template is called, and which of its fields are questions rather
 * than answers.
 *
 * What it answers *with* is not set here: a template is a transaction you
 * have already written, so its values are changed by using it — fill the
 * sheet in, correct what needs correcting, and save it back under the same
 * name. This is for the two things there is nowhere else to say.
 */
export function TemplateSheet({
  open, onClose, editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: TxTemplate | null;
}) {
  const { saveTemplate } = useStore();
  const [name, setName] = useState('');
  const [ask, setAsk] = useState<TemplateField[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !editing) return;
    setName(editing.name);
    setAsk(editing.ask);
    setError(null);
  }, [open, editing]);

  if (!editing) return null;

  // What it holds against each field, so ticking one is a decision made in
  // front of the thing it affects rather than in the abstract. A field it
  // asks for keeps whatever was remembered against it — untick it and that
  // value comes back rather than leaving a hole.
  const held: Record<TemplateField, string | null> = {
    amount: editing.amount ? money(editing.amount) : null,
    account: editing.accountName,
    toAccount: editing.toAccountName,
    category: editing.splits.length
      ? `${editing.splits.length} parts`
      : editing.categoryName,
    merchant: editing.merchant || null,
    note: editing.note,
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError('A template needs a name.');
    setSaving(true);
    try {
      await saveTemplate(templateToInput(editing, { name: trimmed, ask }));
      onClose();
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing.name}
      subtitle="What it is called, and what it leaves for you"
      width={560}
      footer={
        <>
          <div className="foot-lead" />
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button tone="primary" onClick={submit} disabled={saving}>
              Save changes
            </Button>
          </div>
        </>
      }
    >
      <div className="tpl-edit">
        <Field label="Name" error={error}>
          <TextInput
            value={name}
            autoFocus
            placeholder="Rent"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>

        <AskPicker kind={editing.kind} value={ask} onChange={setAsk} />

        <div className="tpl-holds">
          <span className="field-label">What it fills in</span>
          {askableFor(editing.kind).map((field) => {
            const asked = ask.includes(field.key);
            const value = held[field.key];
            return (
              <div key={field.key} className={`tpl-hold ${asked ? 'is-asked' : ''}`}>
                <span className="tpl-hold-name">{field.label}</span>
                <span className="tpl-hold-value">
                  {asked ? (
                    <>
                      <Icon name="circle-help" size={13} />
                      Asked each time
                      {value && <em>{value} remembered</em>}
                    </>
                  ) : (
                    (value ?? <em>Nothing set</em>)
                  )}
                </span>
              </div>
            );
          })}
          {editing.labels.length > 0 && (
            <div className="tpl-hold">
              <span className="tpl-hold-name">Labels</span>
              <span className="tpl-hold-value">
                {editing.labels.map((label) => (
                  <span
                    key={label.id}
                    className="tx-label"
                    style={{ ['--tint' as any]: label.color }}
                  >
                    {label.name}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>

        <p className="page-note">
          <Icon name="circle-help" size={13} />
          To change what it fills in, use it: the sheet opens on this template,
          and saving it back under the same name replaces it.
        </p>
      </div>
    </Sheet>
  );
}
