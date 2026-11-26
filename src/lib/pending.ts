import type { Account, Category, Transaction, TransactionInput } from './types';

/** A posting that isn't in the book yet, dressed as a transaction, so the
 *  transaction sheet opens on it exactly as it opens on a real one.
 *  Denormalised names are looked up here; ids invented here are stripped
 *  again on the way back. */
export function pendingTransaction(
  input: TransactionInput,
  accounts: Account[],
  categories: Category[],
): Transaction {
  const acc = accounts.find((a) => a.id === input.accountId);
  const cat = categories.find((c) => c.id === input.categoryId);
  const catName = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? null;
  return {
    id: '',
    kind: input.kind,
    amount: input.amount,
    accountId: input.accountId,
    toAccountId: input.toAccountId ?? null,
    categoryId: input.categoryId ?? null,
    merchant: input.merchant,
    note: input.note ?? null,
    occurredAt: input.occurredAt,
    createdAt: '',
    accountName: acc?.name ?? '',
    accountColor: acc?.color ?? 'var(--ink-3)',
    toAccountName: accounts.find((a) => a.id === input.toAccountId)?.name ?? null,
    categoryName: cat?.name ?? null,
    categoryIcon: cat?.icon ?? null,
    categoryColor: cat?.color ?? null,
    categoryGroupId: cat ? (cat.parentId ?? cat.id) : null,
    categoryGroupName: cat
      ? (categories.find((p) => p.id === cat.parentId)?.name ?? cat.name)
      : null,
    splits: (input.splits ?? []).map((s, k) => ({
      id: `pending-part-${k}`,
      transactionId: '',
      amount: s.amount,
      categoryId: s.categoryId,
      note: s.note ?? null,
      sortOrder: k,
      categoryName: catName(s.categoryId),
      categoryIcon: null,
      categoryColor: null,
      categoryGroupId: null,
      categoryGroupName: null,
    })),
    shares: (input.shares ?? []).map((s, k) => ({
      debtId: `pending-share-${k}`,
      direction: s.direction,
      counterparty: s.counterparty,
      amount: s.amount,
      dueOn: s.dueOn ?? null,
      note: s.note ?? null,
      paid: 0,
      outstanding: s.amount,
      settled: false,
    })),
    labels: [],
    folders: [],
    // A row waiting to import gives nothing back and has had nothing
    // given back to it: it is not in the book yet to be refunded.
    refundOf: null,
    refundOfMerchant: null,
    refundOfAmount: null,
    refunded: 0,
  };
}
