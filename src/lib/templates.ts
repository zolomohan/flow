import { money } from './format';
import type { TemplateField, TxKind, TxTemplate, TxTemplateInput } from './types';

/**
 * The fields a template can either answer for or ask about, in the order a
 * form asks them. A field belongs to one side of the ledger or the other:
 * only a transfer has an account to arrive in, and only a bill has a category.
 */
export const ASKABLE: { key: TemplateField; label: string; only?: TxKind }[] = [
  { key: 'amount', label: 'Amount' },
  { key: 'account', label: 'Account' },
  { key: 'toAccount', label: 'To account', only: 'transfer' },
  { key: 'category', label: 'Category' },
  { key: 'merchant', label: 'Merchant' },
  { key: 'note', label: 'Note' },
];

/** Which of them a template of this kind has anything to say about. */
export const askableFor = (kind: TxKind) =>
  ASKABLE.filter((field) =>
    field.only ? field.only === kind : !(kind === 'transfer' && field.key === 'category'),
  );

/** What a field is called on the form, which is not always what it is called
 *  in the picker: a transfer has a description where a bill has a merchant. */
export function fieldLabel(field: TemplateField, kind: TxKind) {
  if (field === 'merchant') return kind === 'transfer' ? 'description' : 'merchant';
  if (field === 'account') return kind === 'income' ? 'account to land in' : 'account';
  if (field === 'toAccount') return 'account to move into';
  return field;
}

/**
 * What a template says of itself in one line: what it fills in, then what it
 * will ask you for. A field it asks about is left out of the first half even
 * when a value is remembered against it — the summary is a promise about what
 * arrives filled in, and that one won't.
 */
export function describeTemplate(template: TxTemplate) {
  const asks = (field: TemplateField) => template.ask.includes(field);
  const baked = [
    asks('amount') ? null : template.amount ? money(template.amount) : null,
    asks('category')
      ? null
      : template.splits.length
        ? `${template.splits.length} parts`
        : (template.categoryName ?? (template.kind === 'transfer' ? 'Transfer' : null)),
    asks('account')
      ? null
      : template.kind === 'transfer' && template.toAccountName && !asks('toAccount')
        ? `${template.accountName ?? '—'} → ${template.toAccountName}`
        : template.accountName,
  ].filter(Boolean);

  const asked = askableFor(template.kind)
    .filter((field) => asks(field.key))
    .map((field) => field.label.toLowerCase());

  return [
    baked.join(' · '),
    asked.length ? `asks ${asked.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A template sent back as it stands, for a save that means to change only
 * some of it — its name, or what it asks for. Everything it holds goes back
 * unchanged, since a template is written whole every time.
 */
export const templateToInput = (
  template: TxTemplate,
  over?: Partial<TxTemplateInput>,
): TxTemplateInput => ({
  id: template.id,
  name: template.name,
  kind: template.kind,
  amount: template.amount,
  accountId: template.accountId,
  toAccountId: template.toAccountId,
  categoryId: template.categoryId,
  merchant: template.merchant,
  note: template.note,
  splits: template.splits.map((s) => ({
    amount: s.amount,
    categoryId: s.categoryId,
    note: s.note,
  })),
  labelIds: template.labels.map((l) => l.id),
  ask: template.ask,
  ...over,
});
