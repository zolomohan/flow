import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { Button, Field, Select, Sheet, TextArea, TextInput } from './ui';
import type { SelectOption } from './ui';
import { useStore } from '../lib/store';
import { paiseToRupeeString, rupeesToPaise } from '../lib/format';
import { templateToInput } from '../lib/templates';
import type { TxTemplate } from '../lib/types';

/**
 * What a template is called, and what it fills in.
 *
 * All of it is editable here. It used to be the name alone, on the reasoning
 * that a template is a posting you have already written — so you would change
 * one by using it and saving it back. That is a fine way to correct a whole
 * template and a poor way to change one figure, and it is no way at all to
 * see what a template holds while you edit it.
 *
 * A field left blank is not a gap but the point of one: blank is how a
 * template says "this is different every time", and it comes out blank when
 * the template is used — or asks to be filled in, when a phone is using it.
 */
export function TemplateSheet({
  open, onClose, editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: TxTemplate | null;
}) {
  const { saveTemplate, accounts, categories } = useStore();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !editing) return;
    setName(editing.name);
    setAmount(editing.amount ? paiseToRupeeString(editing.amount) : '');
    setAccountId(editing.accountId);
    setToAccountId(editing.toAccountId);
    setCategoryId(editing.categoryId);
    setMerchant(editing.merchant);
    setNote(editing.note ?? '');
    setError(null);
  }, [open, editing]);

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
    if (!editing) return [];
    const palette = categories.filter(
      (c) => c.kind === (editing.kind === 'income' ? 'income' : 'expense'),
    );
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
  }, [categories, editing]);

  if (!editing) return null;

  // A template split into parts is edited by using it: there is no sensible
  // single category to show, and overwriting the parts from here would throw
  // away work the sheet cannot show.
  const split = editing.splits.length > 0;

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError('A template needs a name.');
    setSaving(true);
    try {
      await saveTemplate(
        templateToInput(editing, {
          name: trimmed,
          amount: rupeesToPaise(amount),
          accountId,
          toAccountId: editing.kind === 'transfer' ? toAccountId : null,
          categoryId: editing.kind === 'transfer' || split ? editing.categoryId : categoryId,
          merchant: merchant.trim(),
          note: note.trim() || null,
        }),
      );
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

        <div className="tpl-fields">
          <Field label="Amount" hint="Blank asks each time">
            <TextInput
              value={amount}
              inputMode="decimal"
              placeholder="Asked for each time"
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field
            label={editing.kind === 'transfer' ? 'Out of' : 'Account'}
            hint="Blank asks each time"
          >
            <Select
              options={accountOptions}
              value={accountId}
              onChange={setAccountId}
              placeholder="Asked for each time"
              allowClear
              clearLabel="Ask each time"
              searchable
            />
          </Field>
          {editing.kind === 'transfer' ? (
            <Field label="Into" hint="Blank asks each time">
              <Select
                options={accountOptions.filter((o) => o.value !== accountId)}
                value={toAccountId}
                onChange={setToAccountId}
                placeholder="Asked for each time"
                allowClear
                clearLabel="Ask each time"
                searchable
              />
            </Field>
          ) : (
            <Field label="Category" hint={split ? `${editing.splits.length} parts` : undefined}>
              <Select
                options={categoryOptions}
                value={split ? null : categoryId}
                onChange={setCategoryId}
                placeholder={split ? 'Split — use it to change the parts' : 'Left blank'}
                disabled={split}
                allowClear
                searchable
              />
            </Field>
          )}
          <Field label="Merchant">
            <TextInput
              value={merchant}
              placeholder="Left blank"
              onChange={(e) => setMerchant(e.target.value)}
            />
          </Field>
          <Field label="Note">
            <TextArea
              value={note}
              placeholder="Left blank"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>

        <p className="page-note">
          <Icon name="circle-help" size={13} />
          A field left blank is a field this template asks for: set the account
          to <strong>Ask each time</strong> and every posting written from it
          asks where the money went — in the sheet, and in the shortcut your
          phone runs. To change the parts of a split, use the template instead
          and save it back under this name.
        </p>
      </div>
    </Sheet>
  );
}
