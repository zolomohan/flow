/**
 * The heads a return asks about, and what each one means.
 *
 * This file is a glossary, not a calculator. Every `note` says what the head
 * is and where it lands on a return; none of them says what it costs. That
 * line is the whole point of the tab — Midas knows exactly what came in and
 * has no business guessing what is owed on it, because the answer moves with
 * a regime, a residency and a budget, and a wrong figure stated confidently
 * is worse than no figure at all.
 *
 * `oldRegimeOnly` is the one piece of tax logic here, and it is a fact about
 * a provision rather than a computation: these shelters exist under the old
 * regime and do not survive 115BAC. Summing what you would forfeit is the
 * input to the regime question, and it is still not a tax figure.
 */

export interface TaxTag {
  id: string;
  label: string;
  /** Where it lands on a return, in the return's own words. */
  note: string;
  icon: string;
  color: string;
  /** Shelters that 115BAC takes away. Undefined on the income side. */
  oldRegimeOnly?: boolean;
}

/** What money coming in can be. Ordered as a return works through it. */
export const INCOME_TAGS: TaxTag[] = [
  {
    id: 'salary',
    label: 'Salary',
    note: 'Schedule S. Pay from an employer, gross as per your Form 16.',
    icon: 'briefcase',
    color: '#6366f1',
  },
  {
    id: 'professional',
    label: 'Professional receipts',
    note: 'Gross receipts from your profession, before expenses rather than profit.',
    icon: 'laptop',
    color: '#0ea5e9',
  },
  {
    id: 'business',
    label: 'Business income',
    note: 'Trade or business filed on books rather than presumptively.',
    icon: 'store',
    color: '#14b8a6',
  },
  {
    id: 'interest',
    label: 'Interest',
    note: 'Schedule OS. Savings, deposits and bonds. Should tie to your AIS.',
    icon: 'landmark',
    color: '#f59e0b',
  },
  {
    id: 'dividend',
    label: 'Dividend',
    note: 'Schedule OS. Taxed at your slab, and also in your AIS.',
    icon: 'coins',
    color: '#eab308',
  },
  {
    id: 'capital_gains',
    label: 'Capital gains',
    note: 'Schedule CG. Your ledger sees the proceeds; the gain comes from your broker.',
    icon: 'trending-up',
    color: '#22c55e',
  },
  {
    id: 'rent',
    label: 'Rent received',
    note: 'Schedule HP. Rent from a property you own.',
    icon: 'house',
    color: '#a855f7',
  },
  {
    id: 'gift',
    label: 'Gifts received',
    note: 's.56(2)(x). Past ₹50,000 a year from non-relatives, taxable in full.',
    icon: 'gift',
    color: '#ec4899',
  },
  {
    id: 'exempt',
    label: 'Exempt income',
    note: 'PPF, EPF on maturity, tax-free bonds. Reportable, not taxable.',
    icon: 'shield-check',
    color: '#64748b',
  },
  {
    id: 'reimbursement',
    label: 'Reimbursement',
    note: 'Money you fronted, coming back. Not income.',
    icon: 'undo-2',
    color: '#94a3b8',
  },
  {
    id: 'repayment',
    label: 'Loan repaid to you',
    note: 'Principal returning, not income. Interest belongs under Interest.',
    icon: 'handshake',
    color: '#94a3b8',
  },
  {
    id: 'other',
    label: 'Other sources',
    note: 'Anything Schedule OS catches with no line of its own.',
    icon: 'circle-help',
    color: '#78716c',
  },
];

/** What money going out can prove. Every one of these is a claim you will
 *  have to evidence, which is why the tab counts the postings too. */
export const DEDUCTION_TAGS: TaxTag[] = [
  {
    id: 's80c',
    label: '80C',
    note: 'ELSS, PPF, life premium, EPF, home loan principal, tuition. ₹1,50,000 cap.',
    icon: 'piggy-bank',
    color: '#6366f1',
    oldRegimeOnly: true,
  },
  {
    id: 's80ccd1b',
    label: '80CCD(1B)',
    note: 'NPS, ₹50,000, over and above the 80C ceiling.',
    icon: 'shield-check',
    color: '#8b5cf6',
    oldRegimeOnly: true,
  },
  {
    id: 's80ccd2',
    label: '80CCD(2)',
    note: 'Your employer’s NPS contribution. Survives into the new regime.',
    icon: 'building-2',
    color: '#0ea5e9',
    oldRegimeOnly: false,
  },
  {
    id: 's80d',
    label: '80D',
    note: 'Health insurance premium, and preventive check-ups within it.',
    icon: 'heart-pulse',
    color: '#ef4444',
    oldRegimeOnly: true,
  },
  {
    id: 'rent_paid',
    label: 'Rent paid',
    note: 's.10(13A). Rent you paid, for the HRA exemption.',
    icon: 'house',
    color: '#a855f7',
    oldRegimeOnly: true,
  },
  {
    id: 'home_loan_interest',
    label: 'Home loan interest',
    note: 's.24(b). ₹2,00,000 on a self-occupied property; uncapped if let out.',
    icon: 'landmark',
    color: '#f97316',
    oldRegimeOnly: true,
  },
  {
    id: 's80e',
    label: '80E',
    note: 'Interest on an education loan. No cap, for eight years.',
    icon: 'graduation-cap',
    color: '#14b8a6',
    oldRegimeOnly: true,
  },
  {
    id: 's80g',
    label: '80G',
    note: 'Donations. 50% or 100% depending on the institution.',
    icon: 'hand-heart',
    color: '#ec4899',
    oldRegimeOnly: true,
  },
  {
    id: 's80tta',
    label: '80TTA / 80TTB',
    note: 'Savings interest: ₹10,000, or ₹50,000 on all deposits if you are 60 or over.',
    icon: 'percent',
    color: '#eab308',
    oldRegimeOnly: true,
  },
  {
    id: 'professional_expense',
    label: 'Professional expenses',
    note: 'Only claimable if you file on books, not under 44ADA.',
    icon: 'receipt',
    color: '#64748b',
    oldRegimeOnly: false,
  },
  {
    id: 'tax_paid',
    label: 'Tax paid',
    note: 'Advance and self-assessment tax. A payment, not a deduction.',
    icon: 'scroll-text',
    color: '#0f766e',
    oldRegimeOnly: false,
  },
];

export const ALL_TAGS = [...INCOME_TAGS, ...DEDUCTION_TAGS];

const BY_ID = new Map(ALL_TAGS.map((t) => [t.id, t]));

/** The unfiled pile answers to the empty string and is a head like any
 *  other — deliberately, so it is impossible to render a year without it. */
export const UNFILED: TaxTag = {
  id: '',
  label: 'Not yet filed',
  note: 'Money the book has, and you have not said what it is. Nothing above is complete until this is empty.',
  icon: 'circle-dashed',
  color: '#f43f5e',
};

export const tagOf = (id: string): TaxTag => BY_ID.get(id) ?? (id ? { ...UNFILED, id, label: id } : UNFILED);

/** The presumptive ceilings, as reference lines rather than verdicts. The
 *  higher one needs cash receipts to stay within 5% of the total, which is a
 *  fact about your receipts that the ledger cannot see. */
export const PRESUMPTIVE = {
  '44ADA': { base: 50_00_000_00, extended: 75_00_000_00 },
  '44AD': { base: 2_00_00_000_00, extended: 3_00_00_000_00 },
} as const;

/** s.56(2)(x): the aggregate at which a year of gifts from non-relatives
 *  stops being exempt — and becomes taxable in full, not on the excess. */
export const GIFT_LIMIT = 50_000_00;
