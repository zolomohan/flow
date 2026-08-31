import { MERCHANT_LOGOS } from './merchant-logos';

/**
 * The key a merchant is looked up by: letters and digits, nothing else.
 *
 * A payee arrives spelled however the statement, the importer or the hand
 * that typed it felt like — "Toni&Guy" and "Toni & Guy", an apostrophe curly
 * from one source and straight from another, "BOX8" against "Box 8". None of
 * those are different shops, so none of them may be different keys.
 *
 * Kept in step with `normalise` in scripts/fetch_merchant_logos.py, which
 * writes the map this reads.
 */
export function merchantKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The logo for a payee, or null when it is a person, a one-off shop, or a
 * brand no directory had a picture of. Null is the ordinary answer for most
 * of a ledger — a row without one keeps its category glyph.
 */
export function merchantLogo(name: string | null | undefined): string | null {
  if (!name) return null;
  const file = MERCHANT_LOGOS[merchantKey(name)];
  return file ? `/merchants/${file}` : null;
}
