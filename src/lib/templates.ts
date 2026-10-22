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

/**
 * What a template leaves for you to answer.
 *
 * A blank is how a template says "this one is different every time", and
 * these are the blanks a posting cannot be written without: the sheet refuses
 * to save until they are filled in, so a template is worth hearing say so
 * before it is used. A blank category or note asks nothing — a posting is
 * perfectly happy without either.
 */
export function asksFor(template: TxTemplate): string[] {
  const asks: string[] = [];
  if (!template.amount) asks.push('an amount');
  if (!template.accountId) {
    asks.push(template.kind === 'transfer' ? 'an account to move out of' : 'an account');
  }
  if (template.kind === 'transfer' && !template.toAccountId) {
    asks.push('an account to move into');
  }
  return asks;
}

/** "a and b", "a, b and c" — a short list read the way it is spoken. */
export const spoken = (parts: string[]) =>
  parts.length < 2
    ? parts[0] ?? ''
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/** What a template says of itself in one line: whatever it fills in, and
 *  what it means to ask for rather than answer. */
export function describeTemplate(template: TxTemplate) {
  const held = heldBy(template);
  // A transfer reads as a route when it knows both ends, and as a
  // destination when the account it leaves is one of the questions.
  const route =
    template.kind === 'transfer' && held.toAccount
      ? held.account
        ? `${held.account} → ${held.toAccount}`
        : `into ${held.toAccount}`
      : held.account;
  const line = [
    held.amount,
    held.category ?? (template.kind === 'transfer' ? 'Transfer' : null),
    route,
  ]
    .filter(Boolean)
    .join(' · ');
  if (!line) return 'Blank, fill it in as you go';
  const asks = asksFor(template);
  return asks.length ? `${line} · asks for ${spoken(asks)}` : line;
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
