import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button, Field, Sheet, TextInput } from './ui';
import { useStore } from '../lib/store';
import { fieldsFor, heldBy, templateToInput } from '../lib/templates';
import type { TxTemplate } from '../lib/types';

/**
 * What a template is called, and what it holds.
 *
 * Only the name is editable here. What it fills in is changed by using it: a
 * template is a transaction you have already written, so you fill the sheet
 * in, correct what needs correcting, and save it back under the same name.
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !editing) return;
    setName(editing.name);
    setError(null);
  }, [open, editing]);

  if (!editing) return null;

  const held = heldBy(editing);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError('A template needs a name.');
    setSaving(true);
    try {
      await saveTemplate(templateToInput(editing, { name: trimmed }));
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
      subtitle="What it is called, and what it fills in"
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

        <div className="tpl-holds">
          <span className="field-label">What it fills in</span>
          {fieldsFor(editing.kind).map((field) => {
            const value = held[field.key];
            return (
              <div key={field.key} className={`tpl-hold ${value ? '' : 'is-blank'}`}>
                <span className="tpl-hold-name">{field.label}</span>
                {/* Blank is not a gap in the template but the point of one:
                    it comes out blank, for you to fill in on the day. */}
                <span className="tpl-hold-value">{value ?? <em>Left blank</em>}</span>
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
          and saving it back under the same name replaces it. A field you leave
          empty is empty here, and empty again next time.
        </p>
      </div>
    </Sheet>
  );
}
