import { money } from './format';
import type { TxKind, TxTemplate, TxTemplateInput } from './types';

/**
 * The fields a template carries, in the order the form asks them. A field
 * belongs to one side of the ledger or the other: only a transfer has an
 * account to arrive in, and only a bill has a category.
 */
const FIELDS: { key: string; label: string; only?: TxKind }[] = [
  { key: 'amount', label: 'Amount' },
  { key: 'account', label: 'Account' },
  { key: 'toAccount', label: 'To account', only: 'transfer' },
  { key: 'category', label: 'Category' },
  { key: 'merchant', label: 'Merchant' },
  { key: 'note', label: 'Note' },
];

/** Which of them a template of this kind has anything to say about. */
export const fieldsFor = (kind: TxKind) =>
  FIELDS.filter((field) =>
    field.only ? field.only === kind : !(kind === 'transfer' && field.key === 'category'),
  );

/**
 * What each field of a template holds, for a list that shows what it will
 * fill in. Null is a field left blank — which is not a gap in the template
 * but the point of it: blank is how a template says "this one is different
 * every time", and it comes out blank when the template is used.
 */
export function heldBy(template: TxTemplate): Record<string, string | null> {
  return {
    amount: template.amount ? money(template.amount) : null,
    account: template.accountName,
    toAccount: template.toAccountName,
    category: template.splits.length
      ? `${template.splits.length} parts`
      : template.categoryName,
    merchant: template.merchant || null,
    note: template.note,
  };
}

/** What a template says of itself in one line: whatever it fills in, and
 *  nothing about what it doesn't. */
export function describeTemplate(template: TxTemplate) {
  const held = heldBy(template);
  const line = [
    held.amount,
    held.category ?? (template.kind === 'transfer' ? 'Transfer' : null),
    template.kind === 'transfer' && held.toAccount
      ? `${held.account ?? '—'} → ${held.toAccount}`
      : held.account,
  ]
    .filter(Boolean)
    .join(' · ');
  return line || 'Blank — fill it in as you go';
}

/**
 * A template sent back as it stands, for a save that means to change only
 * some of it — its name, say. Everything it holds goes back unchanged, since
 * a template is written whole every time.
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
  ...over,
});
