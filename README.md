# Midas

A local-first expense tracker for macOS — Tauri 2 + React 19 + SQLite, built to
Fold's design language (₹ INR, Indian digit grouping).

<img width="900" alt="Midas overview" src="docs/overview.png">

## Running it

```bash
yarn install
yarn tauri dev      # dev, with HMR on the React side
yarn tauri build    # signed .app / .dmg into src-tauri/target/release/bundle
```

The first launch seeds a sample book — about thirteen months of realistic
history across five accounts — so there's something to look at. Wipe it from
**Settings → Your data**.

## What it does

Three kinds of transaction, which is the whole model:

| Kind | Moves | Categorised |
|------|-------|-------------|
| **Income** | into one account | yes |
| **Expense** | out of one account | yes |
| **Transfer** | between two of your own accounts | no — it's internal, so it nets to zero |

Accounts come in five flavours (bank, credit, cash, wallet, investment). A
credit card's balance goes negative as you spend and the card screen labels it
*Outstanding* rather than *Balance*; give it a credit limit and the card also
shows how much is left and how much of the limit is used. Opening balances may
be negative — an imported account often starts overdrawn.

Categories nest one level deep: top-level **groups** (Food & Drink, Transport)
each holding **sub-categories** (Restaurant, Snacks, Coffee / Taxi, Fuel,
Parking). A group can hold transactions directly as well. Lists show the leaf
you picked; the donut and the breakdown roll up to the group, and the
breakdown rows unfold to show what is inside.

**Debts** track money lent and borrowed. A debt has a counterparty, a
principal and any number of partial repayments; outstanding is derived rather
than stored. The debt itself and each repayment can each link to a real
transaction, or stand alone — older debts predate the ledger. A repayment can
also *post* its own transfer: name the account the money landed in (or left
from) and it writes a transfer against `Lent & borrowed`, an archived account
that never counts toward net worth — what is owed is counted by the debt, so
counting the account too would count it twice. A posting the repayment wrote
is rewritten and deleted with it; one you linked is yours and outlives it. Outstanding lent
counts toward net worth as an asset, borrowed as a liability.

**Investments** hold three things. Mutual funds are valued at their latest
NAV and gold at today's rate, both fetched; **deposits** are valued by what
they have earned — an annual rate compounded quarterly the way Indian banks
do, counted from the day each payment went in and stopping at maturity. A
**fixed deposit** is one payment; a **recurring deposit** is an instalment a
month, each earning from its own date. Either way a payment can post a
transfer into the deposit's account or link a record already in your book,
exactly as a fund's purchases do — so the money is never counted twice, and
only the interest on top is new to net worth.

Six screens: **Overview** (net worth, month cash flow, category donut, recent
activity), **Transactions** (search, kind/account/category filters, date ranges,
grouped by day with per-day nets), **Accounts** (grouped cards for managing the accounts
themselves), **Debts**, **Insights** (12-month cash flow, category
breakdown, calendar heat-map), **Settings** (categories, theme, data).

## Importing from Wallet (BudgetBakers)

```bash
python3 scripts/import_wallet_csv.py ~/Downloads/wallet_records.csv --dry-run
python3 scripts/import_wallet_csv.py ~/Downloads/wallet_records.csv
```

Close the app first — the script writes to the SQLite book directly. It
replaces whatever is in the book unless you pass `--keep`.

What it does with the export's quirks:

- **Amounts.** Rows already in INR use `amount`; `ref_currency_amount` is 0 on
  a few transfer legs and on one cross-currency leg carries the *other* side's
  figure. Foreign-currency rows use `ref_currency_amount`, which is the
  converted INR value.
- **Transfers.** Wallet writes a transfer as two rows. Legs that pair on
  (timestamp, amount) collapse into one Midas transfer. Legs whose counterpart
  is missing from the export become a transfer against a placeholder
  `Unlinked` account, so they never masquerade as income or spending.
- **Categories.** The flat list is rebuilt as groups and sub-categories; every
  original category survives as a leaf. The script refuses to run if any
  category in the file has no home in the tree.
- **Timestamps** are UTC in the export and are converted to local wall time.

Opening balances are **not** in the export — Wallet only exports records, never
the initial amount set when an account was created. They live in the `ACCOUNTS`
table at the top of the script, alongside each account's type and credit limit,
so a re-import restores them instead of silently resetting every balance to
zero. `--from YYYY-MM-DD` imports a shorter window; the openings then need to
be the balances as at that date rather than the original initial amounts.

## Importing a bank statement

**Transactions → Import** reads a bank's own export — the legacy `.xls` HDFC
hands out, parsed in Rust by `calamine` — and holds every row against the
book before anything is written:

- **Nothing doubles.** A row that pairs with an existing posting (same amount,
  same side, dates within five days — banks post late) is recognised and set
  aside, so re-importing a statement, or importing one that overlaps hand-kept
  months, is safe.
- **New rows arrive filed.** The importer keeps a memory (`import_rules`) keyed
  on the stable part of the narration — a UPI VPA, an ACH counterparty, a POS
  merchant — and prefills each new row with how that counterparty was filed
  last time. Rows can be refiled in the preview (a category, or a transfer
  against another account), and one decision can be applied to every row of
  the same counterparty at once.
- **You say which rows move the balance.** Money the balance has yet to see
  moves it, as usual. Money it has already seen — a gap you are filling in
  for the record — is written down without moving anything: every opening
  balance the posting touches absorbs it, both ends of a transfer included.
  The review has *Moves the balance: All / None / from ⟨date⟩* with a
  per-row override, and shows exactly what the openings would absorb. Which
  rows are which is asked rather than inferred: nothing about a statement
  reveals what you had already written down.
- **A row can be a hand-off rather than a purchase.** Filing it under
  **Debt** posts it as a transfer against the `Lent & borrowed` account and
  opens a debt in the named counterparty's name, linked to the posting — the
  same shape the lending history was rebuilt around, so it never shows up as
  income or spending.
- **You choose how much comes in.** Every row has an include checkbox, the
  toolbar can flip all or none, and *import until a date* takes the statement
  only up to where your own record begins.
- **Only guesswork wears the Triage label.** A row you opened and filed by
  hand in the review is already reviewed: it skips triage and teaches its
  counterparty's rule on the way in, exactly as confirming would. So does a
  row filed by an already-confirmed rule. Everything else carries the label
  until it's looked over; the Transactions screen shows a banner into
  the queue. Select reviewed rows and **Mark reviewed**: the label comes off
  and the filing is written down as a confirmed rule — which is what makes the
  *next* statement of that counterparty arrive classified and skip triage.

Labels are a small system of their own (`labels` / `transaction_labels`):
pins on top of postings rather than filings. The **Labels** screen creates,
renames, recolours and deletes them (deleting takes a label off every posting
and touches nothing else); the transaction sheet pins them on any entry; the
ledger filters by them. "Triage" is simply the one the importer uses.

A label can also be **silent**, which is the same pin kept to itself: offered
wherever you pin or filter, and drawn nowhere — no chip on the row, none on
the template. It is for a question worth asking often and not worth reading a
hundred times. Postings still carry their silent labels over the wire, because
the sheet has to know what is pinned to let you unpin it.

**Folders** (`folders` / `folder_transactions`) are the third way of grouping,
and the only one that is neither a filing nor a mark: a folder *holds*
postings, by hand, for as long as the thing they are about is going on — the
Goa trip, the kitchen, a year of one client's invoices. Runs like that cut
across every category and account the book has, and no rule could gather them,
because the only thing they have in common is that you say so.

Only ids are kept, so nothing is stored twice: correcting a posting corrects
what the folder says about it, deleting one takes it out of every folder that
held it, and deleting a folder leaves every posting exactly where it was. A
posting can sit in as many folders as you like — a flight to Goa is both the
trip and the year's travel. Gather entries from the folder's own page (the
whole ledger opens in a picker, search and filters and all) or by ticking rows
in the ledger and choosing **Into a folder**. The folder's page opens on what
it came to: the total, the split between money in and out, entries, average,
biggest, the span it covers or what it runs at a month, and a ring of what it
went on — which reads a split bill as the several categories it was filed
under rather than as one.

`scripts/seed_import_rules.py` can prime the rule memory from history: it
pairs old statements against the book the same way the preview does and
writes what it finds as *unconfirmed* rules — suggestions, still triaged,
until confirmed in the app. Its key derivation mirrors
`src-tauri/src/import.rs::match_key` and must be kept in step.

## Importing with Claude

**Transactions → Import with Claude** is a guided version of the statement
import for files the spreadsheet reader can't parse: PDFs, CSVs, other banks'
spreadsheets, even screenshots. Four steps, no chat:

1. **Range** — the account the statements belong to and the dates wanted.
2. **Statements** — one or more files.
3. **Reading** — Claude (`claude-opus-5-5`, from Rust in `ai.rs`) lists every
   transaction in the range and suggests a description, a category from your
   own list and a note for each. Progress streams in as it writes.
4. **Review** — a table to edit descriptions, categories and notes inline,
   open any row in the full transaction editor, and accept or skip rows.

Accepted rows go through the same `preview_import` / `commit_import` as the
spreadsheet importer, so duplicates are set aside, a counterparty whose
filing you confirmed before keeps that filing, and accepting a row teaches its
rule. Rows Claude was unsure of and you left untouched arrive labelled
**Triage**.

**Connecting Claude** (Settings → Claude). Anthropic has no "Sign in with
Claude" for a local app — its third-party OAuth needs a server and an identity
provider, and claude.ai subscriptions can't be used by other apps — so there
are two ways in, tried in this order:

- **The Anthropic CLI's sign-in.** `brew install anthropics/tap/ant`, then
  `ant auth login` and approve in the browser. flow asks `ant` for a
  short-lived token on every read and stores nothing. The sign-in runs out
  after some weeks; log in again when it does.
- **An API key** from platform.claude.com, pasted once and kept in the macOS
  Keychain.

`ANTHROPIC_API_KEY` in the environment is honoured too, for `tauri dev`.
Either way, usage is billed to the Anthropic Console account, not a claude.ai
plan. Statements are sent to Anthropic to be read; password-protected PDFs need
the password taken off first.

## Keyboard

| | |
|---|---|
| `⌘K` | command palette — search transactions, jump anywhere |
| `N` | new transaction |
| `⌘1`–`⌘6` | Overview / Transactions / Accounts / Debts / Insights / Settings |
| `⌘↵` | save, from inside the transaction sheet |
| `esc` | close any sheet |

## How it's put together

```
src-tauri/src/
  models.rs    serde structs shared with the frontend (camelCase over the wire)
  db.rs        schema, migrations, every query
  import.rs    bank statement parsing, and the narration → match-key derivation
  ai.rs        reading statements with Claude, and finding its credential
  demo.rs      the sample book generator
  lib.rs       Tauri commands, one shared connection behind a Mutex

src/
  lib/         types, api (invoke wrappers), formatters, store, motion presets
  components/  ui primitives, charts, sheets, palette, sidebar
  screens/     the five screens
  styles/      tokens.css (palette/type/motion), app.css
```

**Money is stored as integer paise**, never floats — `1_00` is one rupee.
Formatting to `₹1,20,450` happens once, in `lib/format.ts`.

**Balances are derived, not stored.** An account's balance is its opening
balance folded with every posting that touches it, computed in SQL
(`BALANCE_EXPR` in `db.rs`), so it can never drift from the ledger.

The database lives at
`~/Library/Application Support/com.mohanraj.midas/midas.sqlite3`.

## Design

Palette, type scale and easing are taken from fold.money's stylesheet — the
`#20294C` navy, `#F0F1F5` page grey, the `0 9px 25px rgba(32,41,76,.12)` card
lift, and `cubic-bezier(.4, 0, .2, 1)`. Type is General Sans (bundled in
`public/fonts`, no network at runtime) standing in for GT Walsheim.

Motion is [`motion`](https://motion.dev): shared-`layoutId` pills on the nav and
segmented controls, spring sheets over a blurred scrim, staggered list entrances,
count-up on the hero balance, and charts that draw themselves in. Everything
collapses under `prefers-reduced-motion`.

Light and dark both ship. Every colour is a token in `styles/tokens.css`; the
dark block only redefines the tokens.
