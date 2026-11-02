use chrono::{Datelike, Duration, NaiveDate, Utc};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

use crate::models::*;
use crate::prices::Quote;

pub struct Db(pub Mutex<Connection>);

pub type Result<T> = std::result::Result<T, String>;

pub(crate) fn oops<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn new_id() -> String {
    Uuid::new_v4().to_string()
}

/// Every account's live balance, expressed as a correlated subquery so that a
/// single SELECT can return accounts already folded with their postings.
const BALANCE_EXPR: &str = "
    a.opening_balance
  + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.kind = 'income'), 0)
  - COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.kind = 'expense'), 0)
  - COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.kind = 'transfer'), 0)
  + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.to_account_id = a.id AND t.kind = 'transfer'), 0)
";

/// What a card gives back today: the last rate and the last cap recorded
/// against it on or before today, each on its own since a change can name
/// one without the other. Nothing recorded is nothing given back — the book
/// never assumes an offer it was not told about.
const CASHBACK_RATE_NOW: &str = "COALESCE((SELECT ct.cashback_rate_e4 FROM card_terms ct
     WHERE ct.account_id = a.id AND ct.cashback_rate_e4 IS NOT NULL
       AND ct.effective_on <= date('now')
     ORDER BY ct.effective_on DESC LIMIT 1), 0)";
const CASHBACK_CAP_NOW: &str = "COALESCE((SELECT ct.cashback_cap FROM card_terms ct
     WHERE ct.account_id = a.id AND ct.cashback_cap IS NOT NULL
       AND ct.effective_on <= date('now')
     ORDER BY ct.effective_on DESC LIMIT 1), 0)";

/// Joined once, used by both the row query and the totals that go with it —
/// the filters reach into account and category names, so they have to be here.
pub(crate) const TX_FROM: &str = "
FROM transactions t
JOIN accounts a ON a.id = t.account_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN categories p ON p.id = c.parent_id
LEFT JOIN transactions o ON o.id = t.refund_of
";

/// What a posting has had given back to it: every refund naming it, added up.
/// Correlated on `t`, so it drops into anything reading through `TX_FROM` —
/// and into the plain `transactions t` the totals sum over.
pub(crate) const REFUNDED: &str =
    "COALESCE((SELECT SUM(r.amount) FROM transactions r WHERE r.refund_of = t.id), 0)";

/// What the people on a bill owe you back for it: every lent share split off
/// it. The bill left your account in full, but only your own part of it was
/// spending — the rest is money out with them, and the debts carry it.
/// Correlated on `t` the way `REFUNDED` is, and only ever read against an
/// expense.
pub(crate) const SHARED: &str = "COALESCE((SELECT SUM(d.principal) FROM debts d
     WHERE d.transaction_id = t.id AND d.from_split = 1 AND d.direction = 'lent'), 0)";

/// What the card gave back on a purchase: its part of the cycle's cashback.
/// The purchase left the card in full and the cycle's credit pays part of it
/// back, so only the rest was ever spending. Kept on the posting itself by
/// `cashback::settle`, and zero on anything no card gives anything back on.
pub(crate) const CASHBACK: &str = "t.cashback";

/// Postings that are money of their own. A refund is not: it undoes the one
/// it names, and both are netted rather than counted. Nor is the credit a
/// card's cashback lands as — it pays back what the cycle's purchases already
/// count as given back, and counting it as well would count it twice — and
/// that goes for one written by hand as much as for one the book wrote.
pub(crate) const NOT_A_REFUND: &str =
    "(t.refund_of IS NULL AND t.cashback_cycle IS NULL AND t.pays_cashback = 0)";

/// Built rather than pasted: the figure it reads for what has come back is
/// the same expression every total nets by.
pub(crate) fn tx_select() -> String {
    format!(
        "SELECT t.id, t.kind, t.amount, t.account_id, t.to_account_id, t.category_id,
                t.merchant, t.note, t.occurred_at, t.created_at,
                a.name, a.color, ta.name, c.name, c.icon, c.color,
                COALESCE(p.id, c.id), COALESCE(p.name, c.name),
                t.refund_of, o.merchant, o.amount, {REFUNDED},
                t.cashback, t.cashback_set, t.cashback_cycle, t.pays_cashback"
    )
}

/// Every posting as its categories actually see it: an ordinary one once, and
/// a split bill once per line item. Because the parts add up to the posting's
/// own amount, anything summing over this sees the same total either way —
/// only the category each rupee lands under changes.
///
/// `net_amount` is the same figure less what has been refunded, which is what
/// spending is counted by: a bill given back in full is worth nothing, and a
/// part of one comes off the line items in order, earliest first, so the
/// parts still add up to what the bill is now worth.
pub(crate) const ATTRIBUTED: &str = "
SELECT id, kind, occurred_at, merchant, refund_of, cashback_cycle, pays_cashback, account_id,
       category_id, amount,
       -- Only your part of a bill shared with people is spending, and only
       -- what the card did not give back. Both come off the line items in
       -- proportion, each part's running total scaled and the parts taken as
       -- differences, so they still add up to exactly your part rather than
       -- drifting a paisa per line.
       CASE WHEN shared = 0 OR whole <= 0 THEN net_amount
            ELSE upto * MAX(0, whole - shared) / whole
               - (upto - net_amount) * MAX(0, whole - shared) / whole
       END AS net_amount
FROM (
  SELECT x.*,
         SUM(x.net_amount) OVER (PARTITION BY x.id ORDER BY x.sort_order, x.split_id) AS upto,
         SUM(x.net_amount) OVER (PARTITION BY x.id) AS whole
  FROM (
    SELECT t.id, t.kind, t.occurred_at, t.merchant, t.refund_of, t.cashback_cycle,
           t.pays_cashback, t.account_id,
           COALESCE(s.category_id, t.category_id) AS category_id,
           COALESCE(s.amount, t.amount)           AS amount,
           CASE
             WHEN COALESCE(rb.given_back, 0) = 0 THEN COALESCE(s.amount, t.amount)
             WHEN s.id IS NULL THEN t.amount - rb.given_back
             ELSE MAX(0, MIN(s.amount,
                             SUM(s.amount) OVER (PARTITION BY s.transaction_id
                                                 ORDER BY s.sort_order, s.id)
                             - rb.given_back))
           END AS net_amount,
           s.sort_order, s.id AS split_id,
           CASE WHEN t.kind = 'expense' THEN COALESCE(sh.shared, 0) + t.cashback ELSE 0 END AS shared
    FROM transactions t
    LEFT JOIN transaction_splits s ON s.transaction_id = t.id
    LEFT JOIN (SELECT refund_of, SUM(amount) AS given_back
               FROM transactions WHERE refund_of IS NOT NULL
               GROUP BY refund_of) rb ON rb.refund_of = t.id
    LEFT JOIN (SELECT transaction_id, SUM(principal) AS shared
               FROM debts
               WHERE from_split = 1 AND direction = 'lent' AND transaction_id IS NOT NULL
               GROUP BY transaction_id) sh ON sh.transaction_id = t.id
  ) x
)
";

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(oops)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;",
    )
    .map_err(oops)?;
    migrate(&conn)?;
    Ok(conn)
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS accounts (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            kind            TEXT NOT NULL,
            institution     TEXT,
            opening_balance INTEGER NOT NULL DEFAULT 0,
            color           TEXT NOT NULL,
            icon            TEXT NOT NULL,
            archived        INTEGER NOT NULL DEFAULT 0,
            sort_order      INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            credit_limit    INTEGER NOT NULL DEFAULT 0,
            -- A card's billing cycle: the day of the month the statement
            -- closes, and the day the bill is due. Zero on either means that
            -- half is not known, and nothing but a card has either.
            statement_day   INTEGER NOT NULL DEFAULT 0,
            due_day         INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS categories (
            id         TEXT PRIMARY KEY,
            kind       TEXT NOT NULL,
            name       TEXT NOT NULL,
            icon       TEXT NOT NULL,
            color      TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            parent_id  TEXT REFERENCES categories(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id            TEXT PRIMARY KEY,
            kind          TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
            amount        INTEGER NOT NULL CHECK (amount > 0),
            account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            to_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
            category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
            merchant      TEXT NOT NULL DEFAULT '',
            note          TEXT,
            occurred_at   TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            -- The posting this one gives back. A refund undoes what it names
            -- rather than being money of its own: the two cancel, so neither
            -- counts toward what was earned or spent. The money still moved,
            -- so both still count toward the balance.
            refund_of     TEXT REFERENCES transactions(id) ON DELETE SET NULL
        );

        -- A bill filed under more than one category. The parts always add up
        -- to the posting's own amount, so every balance and every total the
        -- ledger computes is untouched by a split: only the attribution moves.
        CREATE TABLE IF NOT EXISTS transaction_splits (
            id             TEXT PRIMARY KEY,
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            amount         INTEGER NOT NULL CHECK (amount > 0),
            category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
            note           TEXT,
            sort_order     INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_splits_tx ON transaction_splits(transaction_id);

        CREATE INDEX IF NOT EXISTS idx_tx_occurred ON transactions(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tx_account  ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_tx_to       ON transactions(to_account_id);
        CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);

        CREATE TABLE IF NOT EXISTS debts (
            id             TEXT PRIMARY KEY,
            direction      TEXT NOT NULL CHECK (direction IN ('lent','borrowed')),
            counterparty   TEXT NOT NULL,
            principal      INTEGER NOT NULL CHECK (principal > 0),
            opened_on      TEXT NOT NULL,
            due_on         TEXT,
            note           TEXT,
            settled_at     TEXT,
            created_at     TEXT NOT NULL,
            transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS debt_payments (
            id             TEXT PRIMARY KEY,
            debt_id        TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
            amount         INTEGER NOT NULL CHECK (amount > 0),
            occurred_at    TEXT NOT NULL,
            note           TEXT,
            transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            created_at     TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_debt_payments ON debt_payments(debt_id);

        -- More handed over against a debt already open: a second loan to the
        -- same friend, a top-up on what was borrowed. The debt's own principal
        -- stays what it opened at, and what it stands at is that plus these —
        -- each one kept, with its day and its posting, the way a repayment is.
        CREATE TABLE IF NOT EXISTS debt_additions (
            id               TEXT PRIMARY KEY,
            debt_id          TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
            amount           INTEGER NOT NULL CHECK (amount > 0),
            occurred_at      TEXT NOT NULL,
            note             TEXT,
            transaction_id   TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            owns_transaction INTEGER NOT NULL DEFAULT 0,
            created_at       TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_debt_additions ON debt_additions(debt_id);

        CREATE TABLE IF NOT EXISTS holdings (
            id          TEXT PRIMARY KEY,
            -- gold and funds are worth what the market says; a deposit is
            -- worth what it has earned, which the book works out itself.
            kind        TEXT NOT NULL CHECK (kind IN ('gold','fund','fd','rd')),
            name        TEXT NOT NULL,
            account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            scheme_code TEXT,
            isin        TEXT,
            purity_e4   INTEGER CHECK (purity_e4 IS NULL OR (purity_e4 > 0 AND purity_e4 <= 10000)),
            -- Grams held, for gold. A fund is measured by its lots instead.
            grams_e4    INTEGER NOT NULL DEFAULT 0 CHECK (grams_e4 >= 0),
            -- The day gold came into your hands, when you know it. A fund
            -- gets its dates from its lots and leaves this null.
            acquired_on TEXT,
            note        TEXT,
            closed_at   TEXT,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS investment_lots (
            id             TEXT PRIMARY KEY,
            holding_id     TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
            kind           TEXT NOT NULL CHECK (kind IN ('buy','sell')),
            quantity_e4    INTEGER NOT NULL CHECK (quantity_e4 > 0),
            amount         INTEGER NOT NULL CHECK (amount >= 0),
            occurred_at    TEXT NOT NULL,
            -- When the units were credited, if that was not the day the money
            -- moved. NULL means the two were the same day.
            allotted_at    TEXT,
            transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            owns_transaction INTEGER NOT NULL DEFAULT 0,
            note           TEXT,
            created_at     TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_lots_holding ON investment_lots(holding_id);

        -- One posting backs at most one lot. Two lots sharing a transfer would
        -- count its cost basis twice and quietly skew net worth.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_lot_tx
            ON investment_lots(transaction_id) WHERE transaction_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS price_cache (
            key        TEXT PRIMARY KEY,
            price_e4   INTEGER NOT NULL,
            as_of      TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            source     TEXT NOT NULL
        );

        -- Every price ever seen for an instrument, one row a day. The cache
        -- above answers what a holding is worth now; this answers what it has
        -- been doing, which is the only thing a chart can be drawn from.
        CREATE TABLE IF NOT EXISTS price_history (
            key      TEXT NOT NULL,
            as_of    TEXT NOT NULL,
            price_e4 INTEGER NOT NULL,
            PRIMARY KEY (key, as_of)
        ) WITHOUT ROWID;

        -- The postings a debt is made of. A debt that came from one bill
        -- points at it directly, and a repayment points at whatever paid it,
        -- but a debt written over years of hand-offs is made of many — and
        -- the only alternative to saying which is guessing by name, which
        -- finds a funeral and a plate of momos looking for a mother.
        CREATE TABLE IF NOT EXISTS debt_entries (
            debt_id        TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            PRIMARY KEY (debt_id, transaction_id)
        ) WITHOUT ROWID;

        -- What a card's terms were, and from when. A limit that has been
        -- raised, a statement day that moved, a due day the bank shifted —
        -- every one of them makes an old cycle read wrong if the card is
        -- taken to have always been as it is now: 60% of the limit in 2024
        -- was a card at its edge, and against today's limit it looks
        -- comfortable. The account carries the terms as they stand today;
        -- this carries the days they changed on.
        --
        -- A column left null is a term that change said nothing about, and
        -- it carries forward from whatever came before it.
        CREATE TABLE IF NOT EXISTS card_terms (
            id            TEXT PRIMARY KEY,
            account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            -- The plain day these terms began, and stood until the next.
            effective_on  TEXT NOT NULL,
            credit_limit  INTEGER,
            statement_day INTEGER,
            due_day       INTEGER,
            note          TEXT,
            created_at    TEXT NOT NULL,
            UNIQUE (account_id, effective_on)
        );
        CREATE INDEX IF NOT EXISTS idx_card_terms
            ON card_terms(account_id, effective_on);

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Labels are pins, not files: a posting keeps its account and its
        -- category, and a label sits on top for as long as it is useful.
        -- \"Triage\" is the one the importer uses; others cost nothing.
        -- A silent label is one you file by and never read: it is offered in
        -- the filters and nowhere else, so a question you ask often costs the
        -- ledger no ink.
        CREATE TABLE IF NOT EXISTS labels (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            color      TEXT NOT NULL,
            silent     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transaction_labels (
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            label_id       TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
            PRIMARY KEY (transaction_id, label_id)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_tx_labels_label ON transaction_labels(label_id);

        -- A folder holds postings rather than marking them: the Goa trip, the
        -- kitchen, a year of one client's invoices. What is in one is said by
        -- hand, because the only thing a run like that has in common is that
        -- you say so. Only ids are kept, so the postings stay where they are
        -- and a folder never holds a stale copy of one.
        CREATE TABLE IF NOT EXISTS folders (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            color      TEXT NOT NULL,
            icon       TEXT NOT NULL,
            note       TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS folder_transactions (
            folder_id      TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            added_at       TEXT NOT NULL,
            PRIMARY KEY (folder_id, transaction_id)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_folder_tx ON folder_transactions(transaction_id);

        -- What the importer has learned about a counterparty: how the last
        -- import of them was filed, keyed on the stable part of the bank's
        -- narration. Confirmed means a person said so; unconfirmed rules were
        -- seeded or inferred, and their suggestions still land in triage.
        -- A transaction worth writing more than once, kept by name. It holds
        -- the shape of a posting and not a posting: no date, because the date
        -- is the one thing that is never the same twice. The three references
        -- are nullable where a posting's are not — an account can be deleted
        -- out from under a template, and the template is still worth keeping.
        CREATE TABLE IF NOT EXISTS transaction_templates (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL UNIQUE,
            kind          TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
            -- Zero means it carries no amount: plenty of bills are the same
            -- every month except the figure.
            amount        INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
            account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
            merchant      TEXT NOT NULL DEFAULT '',
            note          TEXT,
            used_count    INTEGER NOT NULL DEFAULT 0,
            last_used_at  TEXT,
            created_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS template_splits (
            id          TEXT PRIMARY KEY,
            template_id TEXT NOT NULL REFERENCES transaction_templates(id) ON DELETE CASCADE,
            amount      INTEGER NOT NULL CHECK (amount > 0),
            category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
            note        TEXT,
            sort_order  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_template_splits ON template_splits(template_id);

        CREATE TABLE IF NOT EXISTS template_labels (
            template_id TEXT NOT NULL REFERENCES transaction_templates(id) ON DELETE CASCADE,
            label_id    TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
            PRIMARY KEY (template_id, label_id)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS import_rules (
            id              TEXT PRIMARY KEY,
            match_key       TEXT NOT NULL UNIQUE,
            kind            TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
            category_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
            from_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            to_account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            merchant        TEXT NOT NULL DEFAULT '',
            confirmed       INTEGER NOT NULL DEFAULT 0,
            updated_at      TEXT NOT NULL
        );

        -- A payment that comes round again: rent, an EMI, a subscription,
        -- a salary. What is kept here is the promise — when it falls due and
        -- what it ought to come to. Whether any given cycle was actually paid
        -- is never stored, because the ledger already knows: a plan that kept
        -- its own tally would sooner or later disagree with the book, and the
        -- book is the one that has the money in it.
        CREATE TABLE IF NOT EXISTS plans (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            kind            TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
            amount          INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
            account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            to_account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            category_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
            merchant        TEXT NOT NULL DEFAULT '',
            note            TEXT,
            cadence         TEXT NOT NULL CHECK (cadence IN
                                ('weekly','fortnightly','monthly','quarterly',
                                 'half_yearly','yearly')),
            every           INTEGER NOT NULL DEFAULT 1 CHECK (every > 0),
            -- A date the cycle lands on. Every other due date is counted
            -- from it rather than from the one before, so a monthly plan
            -- anchored on the 31st still falls on the last day of a short
            -- month rather than sliding to the 1st. It is not necessarily
            -- the first: a bill whose day has moved is best counted from
            -- where it falls now, and its history is found by walking the
            -- same cycle backwards.
            anchor_on       TEXT NOT NULL,
            ends_on         TEXT,
            -- Cycles deliberately let go: nothing is owed up to this date.
            skipped_through TEXT,
            archived        INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL
        );

        -- The postings a plan is paid by. All of them: a plan finds nothing
        -- on its own, because one payee very often bills several plans and
        -- only the person paying knows which is which.
        CREATE TABLE IF NOT EXISTS plan_entries (
            plan_id        TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            PRIMARY KEY (plan_id, transaction_id)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_plan_entries_tx ON plan_entries(transaction_id);

        -- What a category means to the taxman, which is not what it means to
        -- you. \"Freelance\" is a category; whether it is salary or a
        -- professional receipt is a decision, and this is where the decision
        -- is kept. Untagged is a real state and the honest default: the tab
        -- shows you what it does not know rather than guessing a head.
        CREATE TABLE IF NOT EXISTS tax_map (
            category_id TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
            tag         TEXT NOT NULL
        );

        -- A sentence said out loud, and what the book made of it. The words
        -- are kept whatever happens to them: a capture that resolved wrongly
        -- can only be argued with if what was actually said is still here.
        --
        -- The digest is the line as it arrived, so re-reading the drop file
        -- can never write the same capture twice. Everything the resolver
        -- worked out is nullable, because not knowing is the normal case and
        -- the Inbox exists to be told.
        CREATE TABLE IF NOT EXISTS captures (
            id             TEXT PRIMARY KEY,
            digest         TEXT NOT NULL UNIQUE,
            said           TEXT NOT NULL,
            source         TEXT NOT NULL DEFAULT 'siri',
            captured_at    TEXT NOT NULL,
            ingested_at    TEXT NOT NULL,
            kind           TEXT,
            amount         INTEGER NOT NULL DEFAULT 0,
            account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            to_account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
            merchant       TEXT NOT NULL DEFAULT '',
            occurred_at    TEXT,
            note           TEXT,
            status         TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','posted','dismissed')),
            transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            -- What the resolver could not work out, comma separated: the
            -- Inbox reads it back to say what a row is waiting on.
            unresolved     TEXT NOT NULL DEFAULT '',
            -- The line exactly as the phone wrote it, JSON and all. Kept
            -- because a reading you disagree with can only be argued with
            -- against what was actually sent.
            raw            TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status, captured_at DESC);
        ",
    )
    .map_err(oops)?;
    carry_limits_into_terms(conn)?;
    add_column_if_missing(conn, "captures", "raw", "raw TEXT NOT NULL DEFAULT ''")?;
    // Every label a book already has is one it shows: silence is asked for,
    // never inherited, so the default is exactly right for all of them.
    add_column_if_missing(conn, "labels", "silent", "silent INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "categories", "parent_id", "parent_id TEXT")?;
    // What a recurring deposit puts in each cycle. Zero on anything that is
    // not one, and on an RD nobody has told the book about yet.
    add_column_if_missing(
        conn,
        "holdings",
        "instalment",
        "instalment INTEGER NOT NULL DEFAULT 0",
    )?;
    // The plan a recurring deposit keeps for itself, so its instalment falls
    // due on the Planned screen like any other standing payment. Null on
    // every plan you wrote yourself.
    add_column_if_missing(
        conn,
        "plans",
        "holding_id",
        "holding_id TEXT REFERENCES holdings(id) ON DELETE CASCADE",
    )?;
    add_column_if_missing(
        conn,
        "investment_lots",
        "owns_transaction",
        "owns_transaction INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "investment_lots", "allotted_at", "allotted_at TEXT")?;
    add_column_if_missing(conn, "holdings", "acquired_on", "acquired_on TEXT")?;
    // A deposit's terms: what it pays, when it started, when it comes back.
    add_column_if_missing(conn, "holdings", "rate_e4", "rate_e4 INTEGER")?;
    add_column_if_missing(conn, "holdings", "opened_on", "opened_on TEXT")?;
    add_column_if_missing(conn, "holdings", "matures_on", "matures_on TEXT")?;
    widen_holding_kinds(conn)?;
    add_column_if_missing(
        conn,
        "accounts",
        "credit_limit",
        "credit_limit INTEGER NOT NULL DEFAULT 0",
    )?;
    // Books that predate splitting have debts, but none of them came from a
    // split — the default of 0 is exactly right for every one of them.
    add_column_if_missing(conn, "debts", "from_split", "from_split INTEGER NOT NULL DEFAULT 0")?;
    // A card written before cycles were tracked has none, which is exactly
    // what zero says: the tab reads it by calendar month instead.
    add_column_if_missing(
        conn,
        "accounts",
        "statement_day",
        "statement_day INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "accounts", "due_day", "due_day INTEGER NOT NULL DEFAULT 0")?;
    // Nothing in a book written before refunds existed gives anything back,
    // which is exactly what a column of nulls says. The index waits for the
    // column: a book that already has the table gets the column here, and
    // indexing it up in the batch above would be indexing nothing.
    add_column_if_missing(
        conn,
        "transactions",
        "refund_of",
        "refund_of TEXT REFERENCES transactions(id) ON DELETE SET NULL",
    )?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_tx_refund ON transactions(refund_of);")
        .map_err(oops)?;
    // The counterparty key an imported posting was recognised by, written at
    // import time so confirming it can teach a rule however the note has
    // been rewritten since. Null on anything entered by hand.
    add_column_if_missing(conn, "transactions", "import_key", "import_key TEXT")?;
    // Cashback, which nothing in a book written before it earned: zero is
    // exactly what every posting got back, and no cycle has been credited.
    // What a card gives back is worked out by `cashback::settle` and kept on
    // the posting; what it was said to be by hand, when the card's rate is not
    // the answer, beside it. The credit the cycle's total lands as carries the
    // day that cycle closed, and only the book writes one.
    add_column_if_missing(
        conn,
        "transactions",
        "cashback",
        "cashback INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "transactions", "cashback_set", "cashback_set INTEGER")?;
    add_column_if_missing(conn, "transactions", "cashback_cycle", "cashback_cycle TEXT")?;
    // Cashback written down by hand before the book worked it out — a Rewards
    // row on the card for each payout. While the card's offer covers it, the
    // book reads it as the cycle's credit arriving rather than as income.
    add_column_if_missing(
        conn,
        "transactions",
        "pays_cashback",
        "pays_cashback INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_cashback_cycle
             ON transactions(account_id, cashback_cycle) WHERE cashback_cycle IS NOT NULL;",
    )
    .map_err(oops)?;
    // What a card gives back, as a term like its limit: a rate and a cap on
    // each cycle, from the day they began. A change that says nothing about
    // them leaves them as they were, which is what a null says.
    add_column_if_missing(conn, "card_terms", "cashback_rate_e4", "cashback_rate_e4 INTEGER")?;
    add_column_if_missing(conn, "card_terms", "cashback_cap", "cashback_cap INTEGER")?;
    // Whether a repayment wrote the posting it names. One it wrote goes with
    // it; one you linked is your own record and outlives it. Repayments made
    // before this existed never wrote any, so the default is right.
    add_column_if_missing(
        conn,
        "debt_payments",
        "owns_transaction",
        "owns_transaction INTEGER NOT NULL DEFAULT 0",
    )?;
    // Which repayment spread over somebody's debts a piece belongs to.
    // Everything before spreading existed was paid against one debt.
    add_column_if_missing(conn, "debt_payments", "spread_id", "spread_id TEXT")?;
    // A template once carried a list of the fields it would ask for rather
    // than answer. A field left blank is the question now, so the column says
    // nothing that the template does not already say by being empty.
    drop_column_if_present(conn, "transaction_templates", "ask_fields")?;
    // Three columns a plan no longer has any use for. A plan is paid by what
    // is linked to it, so nothing turns on whether the amount moves or
    // whether it debits itself, and the importer's key stopped being how
    // payments are found. Dropped rather than left to rot, since a column
    // nothing reads is a column somebody will one day believe.
    for dead in ["automatic", "variable", "match_key"] {
        drop_column_if_present(conn, "plans", dead)?;
    }
    migrate_gold_to_grams(conn)?;
    allow_pending_lots(conn)?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);")
        .map_err(oops)?;
    // Sub-categories wear their group's colour. Books that predate the rule
    // are brought into line here rather than left half one way.
    conn.execute(
        "UPDATE categories SET color = (SELECT p.color FROM categories p WHERE p.id = categories.parent_id)
         WHERE parent_id IS NOT NULL
           AND color <> (SELECT p.color FROM categories p WHERE p.id = categories.parent_id)",
        [],
    )
    .map_err(oops)?;
    seed_categories(conn)?;
    // Books written before the icon set grew have whole groups wearing one
    // glyph. Give them the icons a new book is seeded with, once.
    refresh_category_icons(conn)?;
    // A group is a heading rather than a place to file things. Books written
    // before that was true still have postings sitting on one, and so does a
    // book where a category grew its first sub-category yesterday.
    sweep_group_postings(conn)?;
    // Every debt runs through one account now, repayments and hand-offs
    // alike. Postings written before that rule are pointed at it here — and
    // the account itself is named and pinned down on the way past, so the
    // book knows its own from yours.
    debt_account_id(conn)?;
    // A debt entered on the debts screen writes its own transfer, under the
    // counterparty's name — and until now was noted as "Share of" that same
    // name. The note said nothing the debt did not already say, so books
    // written before the rule have it taken back off.
    conn.execute(
        "UPDATE debts SET note = NULL
         WHERE from_split = 1 AND note = 'Share of ' || counterparty",
        [],
    )
    .map_err(oops)?;
    settle_debt_hand_offs(conn)
}

/// Debt hand-offs written before there was an account for them to run
/// through: a transfer with a debt standing against it and nowhere of yours
/// to go. The whole of it has to be owed, or the posting is describing
/// something else as well and is left alone; a transfer that already names an
/// account of yours is left alone too, since that is a movement somebody
/// meant.
fn settle_debt_hand_offs(conn: &Connection) -> Result<()> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.account_id, d.direction
             FROM transactions t
             JOIN debts d ON d.transaction_id = t.id
             WHERE t.kind = 'transfer'
               AND (t.to_account_id IS NULL OR t.to_account_id = '')
             GROUP BY t.id
             HAVING SUM(d.principal) = t.amount",
        )
        .map_err(oops)?;
    let orphans: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);
    if orphans.is_empty() {
        return Ok(());
    }
    let holding = debt_account(conn)?;
    for (id, account_id, direction) in orphans {
        if account_id == holding {
            continue;
        }
        // Lent: out of your account and into what is out with people.
        // Borrowed: in from it, landing where the money actually arrived.
        if direction == "borrowed" {
            conn.execute(
                "UPDATE transactions SET account_id = ?2, to_account_id = ?3 WHERE id = ?1",
                params![id, holding, account_id],
            )
        } else {
            conn.execute(
                "UPDATE transactions SET to_account_id = ?2 WHERE id = ?1",
                params![id, holding],
            )
        }
        .map_err(oops)?;
    }
    Ok(())
}

/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so check the table first. Books
/// created before category nesting existed pick the column up on next launch.
/// The limit history came before the cycle days did, in a table of its own.
/// Everything it holds is a card term like any other, so it moves across and
/// the narrower table goes.
fn carry_limits_into_terms(conn: &Connection) -> Result<()> {
    let had: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'credit_limits'",
            [],
            |r| r.get(0),
        )
        .map_err(oops)?;
    if had == 0 {
        return Ok(());
    }
    conn.execute_batch(
        "INSERT OR IGNORE INTO card_terms
             (id, account_id, effective_on, credit_limit, statement_day, due_day, note, created_at)
         SELECT id, account_id, effective_on, amount, NULL, NULL, note, created_at
         FROM credit_limits;
         DROP TABLE credit_limits;",
    )
    .map_err(oops)
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(oops)?;
    let present = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(oops)?
        .filter_map(std::result::Result::ok)
        .any(|name| name == column);
    if !present {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {decl}"), [])
            .map_err(oops)?;
    }
    Ok(())
}

/// The other half of `add_column_if_missing`: takes a column back out once
/// nothing reads it. Books that never had it are left alone.
fn drop_column_if_present(conn: &Connection, table: &str, column: &str) -> Result<()> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(oops)?;
    let present = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(oops)?
        .filter_map(std::result::Result::ok)
        .any(|name| name == column);
    drop(stmt);
    if present {
        conn.execute(&format!("ALTER TABLE {table} DROP COLUMN {column}"), [])
            .map_err(oops)?;
    }
    Ok(())
}

/// Books written before deposits existed carry a CHECK that allows only gold
/// and funds, and SQLite cannot alter one in place — so the table is rebuilt
/// around the wider rule. Everything in it is copied across untouched; only
/// what the column will accept from here on changes.
fn widen_holding_kinds(conn: &Connection) -> Result<()> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'holdings'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .unwrap_or_default();
    if sql.contains("'fd'") || !sql.contains("CHECK (kind IN") {
        return Ok(());
    }
    // Foreign keys are enforced on this connection and investment_lots points
    // at holdings, so the swap happens with them off — and inside no
    // transaction, which is the one place that pragma can be changed.
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
         BEGIN;
         CREATE TABLE holdings_widened (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL CHECK (kind IN ('gold','fund','fd','rd')),
            name        TEXT NOT NULL,
            account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            scheme_code TEXT,
            isin        TEXT,
            purity_e4   INTEGER CHECK (purity_e4 IS NULL OR (purity_e4 > 0 AND purity_e4 <= 10000)),
            grams_e4    INTEGER NOT NULL DEFAULT 0,
            acquired_on TEXT,
            rate_e4     INTEGER,
            opened_on   TEXT,
            matures_on  TEXT,
            note        TEXT,
            closed_at   TEXT,
            created_at  TEXT NOT NULL
         );
         INSERT INTO holdings_widened
            (id, kind, name, account_id, scheme_code, isin, purity_e4, grams_e4,
             acquired_on, rate_e4, opened_on, matures_on, note, closed_at, created_at)
         SELECT id, kind, name, account_id, scheme_code, isin, purity_e4, grams_e4,
                acquired_on, rate_e4, opened_on, matures_on, note, closed_at, created_at
         FROM holdings;
         DROP TABLE holdings;
         ALTER TABLE holdings_widened RENAME TO holdings;
         COMMIT;
         PRAGMA foreign_keys = ON;",
    )
    .map_err(oops)?;
    Ok(())
}

/// Money goes in on one day and the units land on another — often days later,
/// at whatever NAV the AMC processed it on. Until then the purchase is real
/// and the units are not, so a lot has to be able to hold nothing: the old
/// CHECK insisted on more than zero. SQLite cannot alter a CHECK in place, so
/// the table is rebuilt around the wider rule with everything copied across.
fn allow_pending_lots(conn: &Connection) -> Result<()> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'investment_lots'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .unwrap_or_default();
    if !sql.contains("quantity_e4    INTEGER NOT NULL CHECK (quantity_e4 > 0)")
        && !sql.contains("quantity_e4 INTEGER NOT NULL CHECK (quantity_e4 > 0)")
    {
        return Ok(());
    }
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
         BEGIN;
         CREATE TABLE lots_widened (
            id             TEXT PRIMARY KEY,
            holding_id     TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
            kind           TEXT NOT NULL CHECK (kind IN ('buy','sell')),
            -- Zero means the money has gone in and the units have not landed.
            quantity_e4    INTEGER NOT NULL CHECK (quantity_e4 >= 0),
            amount         INTEGER NOT NULL CHECK (amount >= 0),
            occurred_at    TEXT NOT NULL,
            allotted_at    TEXT,
            transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            owns_transaction INTEGER NOT NULL DEFAULT 0,
            note           TEXT,
            created_at     TEXT NOT NULL
         );
         INSERT INTO lots_widened
            (id, holding_id, kind, quantity_e4, amount, occurred_at, allotted_at,
             transaction_id, owns_transaction, note, created_at)
         SELECT id, holding_id, kind, quantity_e4, amount, occurred_at, allotted_at,
                transaction_id, owns_transaction, note, created_at
         FROM investment_lots;
         DROP TABLE investment_lots;
         ALTER TABLE lots_widened RENAME TO investment_lots;
         CREATE INDEX IF NOT EXISTS idx_lots_holding ON investment_lots(holding_id);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_lot_tx
            ON investment_lots(transaction_id) WHERE transaction_id IS NOT NULL;
         COMMIT;
         PRAGMA foreign_keys = ON;",
    )
    .map_err(oops)?;
    Ok(())
}

/// Gold used to be traded in lots like a fund. It isn't a position you trade
/// — it is metal in a locker — so the grams its lots came to become the
/// holding's own weight, and the lots go. Whatever those lots posted to the
/// ledger stays: money really did leave the bank.
fn migrate_gold_to_grams(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "holdings",
        "grams_e4",
        "grams_e4 INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(
        "UPDATE holdings SET grams_e4 = MAX(0, COALESCE(
             (SELECT SUM(CASE WHEN l.kind = 'buy' THEN l.quantity_e4
                              ELSE -l.quantity_e4 END)
              FROM investment_lots l WHERE l.holding_id = holdings.id), 0))
         WHERE kind = 'gold' AND grams_e4 = 0;

         DELETE FROM investment_lots WHERE holding_id IN
             (SELECT id FROM holdings WHERE kind = 'gold');

         -- Nothing posts into an account any more, so the link would only
         -- ever mislead about where the metal's cost is sitting.
         UPDATE holdings SET account_id = NULL WHERE kind = 'gold';",
    )
    .map_err(oops)
}

/// Fold-flavoured starting taxonomy. Only inserted once; user edits survive.
fn seed_categories(conn: &Connection) -> Result<()> {
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))
        .map_err(oops)?;
    if existing > 0 {
        return Ok(());
    }

    let expense = [
        ("Food & Drink", "utensils", "#F2724F"),
        ("Groceries", "shopping-basket", "#42C251"),
        ("Transport", "car-front", "#118AE4"),
        ("Shopping", "shopping-bag", "#A855F7"),
        ("Bills & Utilities", "zap", "#F0B429"),
        ("Rent & Home", "house", "#5A87E6"),
        ("Health", "heart-pulse", "#EC4899"),
        ("Entertainment", "clapperboard", "#8B5CF6"),
        ("Travel", "plane", "#06B6D4"),
        ("Education", "graduation-cap", "#0EA5E9"),
        ("Subscriptions", "repeat", "#14B8A6"),
        ("Fees & Charges", "receipt", "#94A3B8"),
        ("Family & Gifts", "gift", "#F43F5E"),
        ("Other", "circle-dashed", "#676B89"),
    ];
    let income = [
        ("Salary", "briefcase", "#42C251"),
        ("Business", "store", "#0F9D58"),
        ("Interest", "piggy-bank", "#118AE4"),
        ("Investments", "trending-up", "#7C3AED"),
        ("Refunds", "undo-2", "#F0B429"),
        ("Gifts", "gift", "#F43F5E"),
        ("Other Income", "circle-dashed", "#676B89"),
    ];

    let mut stmt = conn
        .prepare("INSERT INTO categories (id, kind, name, icon, color, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .map_err(oops)?;
    for (i, (name, icon, color)) in expense.iter().enumerate() {
        stmt.execute(params![new_id(), "expense", name, icon, color, i as i64])
            .map_err(oops)?;
    }
    for (i, (name, icon, color)) in income.iter().enumerate() {
        stmt.execute(params![new_id(), "income", name, icon, color, i as i64])
            .map_err(oops)?;
    }
    Ok(())
}


/// Every category name this book has grown, and the glyph that actually says
/// what it is. Keyed on the group as well as the name, because "Gifts" under
/// Work is not the same errand as "Gifts" under Relationship, and "Shopping"
/// under Home is furniture where under Tech it is a laptop.
///
/// `("", name)` matches a top-level group; anything not named here keeps
/// whatever icon it already has.
const CATEGORY_GLYPHS: &[(&str, &str, &str)] = &[
    // -------------------------------------------------------- expense
    ("", "Education", "graduation-cap"),
    ("", "Family", "users-round"),
    ("Family", "Support", "hand-heart"),
    ("Family", "Hangouts", "party-popper"),
    ("Family", "Gifts", "gift"),
    ("Family", "Life", "heart"),
    ("", "Financial", "landmark"),
    ("Financial", "Loans, interests", "handshake"),
    ("Financial", "Unknown", "circle-help"),
    ("Financial", "Taxes", "percent"),
    ("Financial", "Charges, Fees", "receipt"),
    ("Financial", "Gold", "gem"),
    ("", "Food & Drink", "utensils"),
    ("Food & Drink", "Restaurant", "utensils-crossed"),
    ("Food & Drink", "Snacks", "cookie"),
    ("Food & Drink", "Groceries", "shopping-basket"),
    ("Food & Drink", "Coffee", "coffee"),
    ("Food & Drink", "Drinks", "beer"),
    ("Food & Drink", "Others", "hand-platter"),
    ("Food & Drink", "Subscription", "repeat"),
    ("", "Friends", "users"),
    ("Friends", "Gifts", "gift"),
    ("Friends", "Hangouts", "party-popper"),
    ("", "Health", "heart-pulse"),
    ("Health", "Drugstore", "pill"),
    ("Health", "Medical", "stethoscope"),
    ("Health", "Health and beauty", "sparkles"),
    ("Health", "Fitness", "dumbbell"),
    ("Health", "Others", "hospital"),
    ("Health", "Relaxation", "flower-2"),
    ("Health", "Grooming", "scissors"),
    ("", "Hobbies", "palette"),
    ("Hobbies", "Movies", "clapperboard"),
    ("Hobbies", "Games", "gamepad-2"),
    ("Hobbies", "Software, apps, games", "app-window"),
    ("Hobbies", "Fun", "sparkles"),
    ("Hobbies", "Events", "ticket"),
    ("Hobbies", "Diving", "waves"),
    ("Hobbies", "Books", "book-open"),
    ("Hobbies", "Track", "flag"),
    ("Hobbies", "Cubing", "box"),
    ("Hobbies", "Misc", "shapes"),
    ("", "Home", "house"),
    ("Home", "Rent", "key-round"),
    ("Home", "Shopping", "sofa"),
    ("Home", "Energy, utilities", "zap"),
    ("Home", "Fees", "receipt"),
    ("Home", "Maintenance", "wrench"),
    ("Home", "Services", "hammer"),
    ("", "Others", "circle-dashed"),
    ("Others", "Unknown", "circle-help"),
    ("Others", "Charity", "heart-handshake"),
    ("", "Relationship", "heart"),
    ("Relationship", "Date", "wine"),
    ("Relationship", "Taxi", "car-taxi-front"),
    ("Relationship", "Gifts", "gift"),
    ("Relationship", "Misc", "heart"),
    ("Relationship", "Takeaway", "soup"),
    ("", "Shopping", "shopping-bag"),
    ("Shopping", "Clothes", "shirt"),
    ("Shopping", "Electronics", "smartphone"),
    ("Shopping", "Accessories", "watch"),
    ("Shopping", "Stationery", "pencil-ruler"),
    ("Shopping", "Others", "shopping-cart"),
    ("", "Tech", "cpu"),
    ("Tech", "Broadband", "wifi"),
    ("Tech", "Phone", "smartphone"),
    ("Tech", "Repairs", "wrench"),
    ("Tech", "Subscriptions", "repeat"),
    ("Tech", "Shopping", "laptop"),
    ("", "Transport", "car-front"),
    ("Transport", "Taxi", "car-taxi-front"),
    ("Transport", "Public", "bus"),
    ("Transport", "Long Distance", "train-front"),
    ("Transport", "Rentals", "key-round"),
    ("", "Travel", "plane"),
    ("Travel", "Vacation", "palmtree"),
    ("Travel", "Business trips", "briefcase"),
    ("Travel", "Others", "luggage"),
    ("", "Vehicle", "car"),
    ("Vehicle", "Fuel", "fuel"),
    ("Vehicle", "Parking", "square-parking"),
    ("Vehicle", "Insurance", "shield-check"),
    ("Vehicle", "Services", "wrench"),
    ("Vehicle", "Maintanence", "cog"),
    ("Vehicle", "Maintenance", "cog"),
    ("Vehicle", "Govt", "scroll-text"),
    ("", "Work", "briefcase"),
    ("Work", "Gifts", "gift"),
    ("Work", "Misc", "briefcase"),
    // Names the default book seeds that this one happens not to have.
    ("", "Bills & Utilities", "zap"),
    ("", "Groceries", "shopping-basket"),
    ("", "Rent & Home", "house"),
    ("", "Entertainment", "clapperboard"),
    ("", "Subscriptions", "repeat"),
    ("", "Fees & Charges", "receipt"),
    ("", "Family & Gifts", "gift"),
    // --------------------------------------------------------- income
    ("", "Adjustments", "sliders-horizontal"),
    ("Adjustments", "Adjustment", "sliders-horizontal"),
    ("", "Gifts", "gift"),
    ("", "Interest & Sales", "trending-up"),
    ("Interest & Sales", "Interests", "piggy-bank"),
    ("Interest & Sales", "Sale", "tag"),
    ("", "Lending & Renting", "handshake"),
    ("Lending & Renting", "Lending, renting", "handshake"),
    ("", "Other Income", "circle-dashed"),
    ("Other Income", "Others", "circle-dashed"),
    ("Other Income", "Other", "circle-dashed"),
    ("Other Income", "Loans, interests", "handshake"),
    ("Other Income", "Financial expenses", "receipt"),
    ("Other Income", "Restaurant", "utensils-crossed"),
    ("", "Refunds & Rewards", "undo-2"),
    ("Refunds & Rewards", "Refunds", "undo-2"),
    ("Refunds & Rewards", "Rewards", "award"),
    ("", "Salary & Wages", "briefcase"),
    ("Salary & Wages", "Wage, invoices", "banknote"),
    ("Salary & Wages", "Income", "wallet"),
    ("", "Salary", "briefcase"),
    ("", "Business", "store"),
    ("", "Interest", "piggy-bank"),
    ("", "Investments", "trending-up"),
    ("", "Refunds", "undo-2"),
    ("", "Other Income", "circle-dashed"),
];

/// A book written before the icon set was any good has whole groups wearing
/// one glyph — every sub-category of Health a heartbeat, every child of
/// Family a present. This walks the names above over what is there once, so
/// an existing book gets the same icons a new one is seeded with. It runs a
/// single time: after it, the icon on a category is whatever its owner last
/// chose, and nothing here overrules that.
fn refresh_category_icons(conn: &Connection) -> Result<()> {
    if setting(conn, ICON_REFRESH_KEY)?.is_some() {
        return Ok(());
    }
    let mut stmt = conn
        .prepare(
            "UPDATE categories SET icon = ?3
             WHERE name = ?2
               AND COALESCE((SELECT p.name FROM categories p WHERE p.id = categories.parent_id), '') = ?1
               AND icon <> ?3",
        )
        .map_err(oops)?;
    for (parent, name, icon) in CATEGORY_GLYPHS {
        stmt.execute(params![parent, name, icon]).map_err(oops)?;
    }
    drop(stmt);
    set_setting(conn, ICON_REFRESH_KEY, "1")
}

/// Marks the one-time icon pass above as done.
const ICON_REFRESH_KEY: &str = "category_icons_refreshed";

// ---------------------------------------------------------------- accounts

fn account_from_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        institution: r.get(3)?,
        opening_balance: r.get(4)?,
        color: r.get(5)?,
        icon: r.get(6)?,
        archived: r.get::<_, i64>(7)? != 0,
        sort_order: r.get(8)?,
        created_at: r.get(9)?,
        balance: r.get(10)?,
        credit_limit: r.get(11)?,
        statement_day: r.get(12)?,
        due_day: r.get(13)?,
        cashback_rate_e4: r.get(14)?,
        cashback_cap: r.get(15)?,
        // Both filled in by `apply_marks`: the ledger alone knows nothing
        // about what a holding is worth today, nor which account is the
        // book's own.
        revaluation: 0,
        system: false,
    })
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<Account>> {
    let sql = format!(
        "SELECT a.id, a.name, a.kind, a.institution, a.opening_balance, a.color, a.icon,
                a.archived, a.sort_order, a.created_at, {BALANCE_EXPR} AS balance,
                a.credit_limit, a.statement_day, a.due_day,
                {CASHBACK_RATE_NOW}, {CASHBACK_CAP_NOW}
         FROM accounts a
         ORDER BY a.archived ASC, a.sort_order ASC, a.created_at ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt.query_map([], account_from_row).map_err(oops)?;
    let mut accounts = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)?;
    apply_marks(conn, &mut accounts)?;
    Ok(accounts)
}

fn get_account(conn: &Connection, id: &str) -> Result<Account> {
    let sql = format!(
        "SELECT a.id, a.name, a.kind, a.institution, a.opening_balance, a.color, a.icon,
                a.archived, a.sort_order, a.created_at, {BALANCE_EXPR} AS balance,
                a.credit_limit, a.statement_day, a.due_day,
                {CASHBACK_RATE_NOW}, {CASHBACK_CAP_NOW}
         FROM accounts a WHERE a.id = ?1"
    );
    let mut one = vec![conn
        .query_row(&sql, params![id], account_from_row)
        .map_err(oops)?];
    apply_marks(conn, &mut one)?;
    Ok(one.remove(0))
}

/// A day of the month a cycle can actually land on, or nothing. Only a card
/// has one, and 1–31 is the whole of what a day of the month can be — which
/// month it falls in is the caller's business, not the column's.
/// The book's own account is not yours to change: every debt runs through it,
/// and a rename, an archive or a delete would take the other side out from
/// under every hand-off in the ledger.
fn refuse_the_books_own(conn: &Connection, id: &str) -> Result<()> {
    if debt_account_id(conn)?.as_deref() == Some(id) {
        return Err(format!(
            "{DEBT_ACCOUNT} is the book's own account — every debt runs through it, so it is not yours to change."
        ));
    }
    Ok(())
}

pub fn save_account(conn: &Connection, input: AccountInput) -> Result<Account> {
    match input.id {
        Some(id) => {
            refuse_the_books_own(conn, &id)?;
            conn.execute(
                // A card's terms are not this form's to write: the limit and
                // both cycle days follow the changes recorded against it, so
                // saving the account leaves them exactly as they were. An
                // account that stops being a card keeps none of them, since
                // nothing would ever read them again.
                "UPDATE accounts SET name = ?2, kind = ?3, institution = ?4,
                        opening_balance = ?5, color = ?6, icon = ?7,
                        credit_limit   = CASE WHEN ?3 = 'credit' THEN credit_limit ELSE 0 END,
                        statement_day  = CASE WHEN ?3 = 'credit' THEN statement_day ELSE 0 END,
                        due_day        = CASE WHEN ?3 = 'credit' THEN due_day ELSE 0 END
                 WHERE id = ?1",
                params![
                    id,
                    input.name,
                    input.kind,
                    input.institution,
                    input.opening_balance,
                    input.color,
                    input.icon,
                ],
            )
            .map_err(oops)?;
            get_account(conn, &id)
        }
        None => {
            let id = new_id();
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts",
                    [],
                    |r| r.get(0),
                )
                .map_err(oops)?;
            conn.execute(
                "INSERT INTO accounts (id, name, kind, institution, opening_balance, color, icon,
                                       archived, sort_order, created_at, credit_limit,
                                       statement_day, due_day)
                 -- A new card is on no terms at all until a change is
                 -- recorded against it, which is where every one of them
                 -- comes from.
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, 0, 0, 0)",
                params![
                    id,
                    input.name,
                    input.kind,
                    input.institution,
                    input.opening_balance,
                    input.color,
                    input.icon,
                    next,
                    now(),
                ],
            )
            .map_err(oops)?;
            get_account(conn, &id)
        }
    }
}

pub fn set_account_archived(conn: &Connection, id: &str, archived: bool) -> Result<()> {
    refuse_the_books_own(conn, id)?;
    conn.execute(
        "UPDATE accounts SET archived = ?2 WHERE id = ?1",
        params![id, archived as i64],
    )
    .map_err(oops)?;
    Ok(())
}

pub fn delete_account(conn: &Connection, id: &str) -> Result<()> {
    refuse_the_books_own(conn, id)?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

pub fn reorder_accounts(conn: &Connection, ids: Vec<String>) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE accounts SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        )
        .map_err(oops)?;
    }
    Ok(())
}

// -------------------------------------------------------------- categories

pub fn list_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, icon, color, sort_order, parent_id FROM categories
             ORDER BY kind DESC, sort_order ASC, name ASC",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                icon: r.get(3)?,
                color: r.get(4)?,
                sort_order: r.get(5)?,
                parent_id: r.get(6)?,
            })
        })
        .map_err(oops)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)
}

/// Whether anything is filed under this category, making it a group rather
/// than a place to file things.
fn is_group(conn: &Connection, id: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM categories WHERE parent_id = ?1)",
        params![id],
        |r| r.get::<_, i64>(0),
    )
    .map_err(oops)
    .map(|n| n != 0)
}

/// A group is a heading, not a category: what it stands for is the sum of
/// what is under it, and a posting filed against the heading itself is
/// counted in the group's total while belonging to none of its parts.
fn refuse_a_group(conn: &Connection, category_id: Option<&str>) -> Result<()> {
    let Some(id) = category_id else { return Ok(()) };
    if is_group(conn, id)? {
        return Err(
            "That one has sub-categories. Pick the one underneath it that this belongs to."
                .into(),
        );
    }
    Ok(())
}

/// The sub-category a group's own postings go to once it stops being a place
/// to file things — made only when there is something to put in it, and
/// reused ever after.
fn others_under(conn: &Connection, parent: &str) -> Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM categories WHERE parent_id = ?1 AND name = 'Others'",
            params![parent],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let (kind, icon, color): (String, String, String) = conn
        .query_row(
            "SELECT kind, icon, color FROM categories WHERE id = ?1",
            params![parent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(oops)?;
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories WHERE kind = ?1",
            params![kind],
            |r| r.get(0),
        )
        .map_err(oops)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO categories (id, kind, name, icon, color, sort_order, parent_id)
         VALUES (?1, ?2, 'Others', ?3, ?4, ?5, ?6)",
        params![id, kind, icon, color, next, parent],
    )
    .map_err(oops)?;
    Ok(id)
}

/// Moves whatever is filed against a group itself into an `Others` beneath
/// it. Runs at every launch, so a book from before the rule — or one where a
/// category grew its first sub-category yesterday — puts itself right.
pub fn sweep_group_postings(conn: &Connection) -> Result<()> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id FROM categories p
             WHERE EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = p.id)
               AND (EXISTS (SELECT 1 FROM transactions t WHERE t.category_id = p.id)
                 OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.category_id = p.id))",
        )
        .map_err(oops)?;
    let groups = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);

    for group in groups {
        let others = others_under(conn, &group)?;
        conn.execute(
            "UPDATE transactions SET category_id = ?2 WHERE category_id = ?1",
            params![group, others],
        )
        .map_err(oops)?;
        conn.execute(
            "UPDATE transaction_splits SET category_id = ?2 WHERE category_id = ?1",
            params![group, others],
        )
        .map_err(oops)?;
    }
    Ok(())
}

pub fn save_category(conn: &Connection, input: CategoryInput) -> Result<Category> {
    // Nesting is exactly one level deep, and a category can never be its own
    // ancestor — reject anything that would build a deeper or cyclic tree.
    let mut color = input.color;
    let parent_id = match input.parent_id.filter(|p| !p.is_empty()) {
        None => None,
        Some(parent) => {
            if Some(&parent) == input.id.as_ref() {
                return Err("A category cannot be its own parent.".into());
            }
            let (grandparent, parent_color): (Option<String>, String) = conn
                .query_row(
                    "SELECT parent_id, color FROM categories WHERE id = ?1",
                    params![parent],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(oops)?
                .ok_or("That group no longer exists.")?;
            if grandparent.is_some() {
                return Err("Categories only nest one level deep.".into());
            }
            // A sub-category is a shade of its group, not a colour of its own:
            // the charts read the group, and two tones for one thing only ever
            // looked like a mistake.
            color = parent_color;
            Some(parent)
        }
    };

    let id = match input.id {
        Some(id) => {
            conn.execute(
                "UPDATE categories SET kind = ?2, name = ?3, icon = ?4, color = ?5, parent_id = ?6
                 WHERE id = ?1",
                params![id, input.kind, input.name, input.icon, color, parent_id],
            )
            .map_err(oops)?;
            if parent_id.is_some() {
                // Moving a group under a parent would orphan its children two
                // levels down, so lift them to the top instead.
                conn.execute(
                    "UPDATE categories SET parent_id = NULL WHERE parent_id = ?1",
                    params![id],
                )
                .map_err(oops)?;
            } else {
                // Recolouring a group recolours everything filed under it.
                conn.execute(
                    "UPDATE categories SET color = ?2 WHERE parent_id = ?1",
                    params![id, color],
                )
                .map_err(oops)?;
            }
            id
        }
        None => {
            let id = new_id();
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories WHERE kind = ?1",
                    params![input.kind],
                    |r| r.get(0),
                )
                .map_err(oops)?;
            conn.execute(
                "INSERT INTO categories (id, kind, name, icon, color, sort_order, parent_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, input.kind, input.name, input.icon, color, next, parent_id],
            )
            .map_err(oops)?;
            id
        }
    };
    // Whatever was filed against the new parent belongs under it now, not on
    // it: a group is a heading, and its own postings become its `Others`.
    if let Some(parent) = &parent_id {
        sweep_group_postings(conn)?;
        let _ = parent;
    }
    conn.query_row(
        "SELECT id, kind, name, icon, color, sort_order, parent_id FROM categories WHERE id = ?1",
        params![id],
        |r| {
            Ok(Category {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                icon: r.get(3)?,
                color: r.get(4)?,
                sort_order: r.get(5)?,
                parent_id: r.get(6)?,
            })
        },
    )
    .map_err(oops)
}

/// Writes the order the categories screen was left in. The ids arrive already
/// flattened — every group followed by its own children — so one running
/// number is enough: siblings only ever compare against siblings.
pub fn reorder_categories(conn: &Connection, ids: Vec<String>) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        )
        .map_err(oops)?;
    }
    Ok(())
}

/// Transactions filed under each category, keyed by category id. Categories
/// with nothing filed under them are left out entirely.
pub fn category_usage(conn: &Connection) -> Result<HashMap<String, i64>> {
    let mut stmt = conn
        .prepare(
            // A split bill counts under every category it was filed against,
            // not just the one on the posting — otherwise a category used only
            // as part of a split looks unused and is offered up for deletion.
            &format!(
                "SELECT category_id, COUNT(*) FROM ({ATTRIBUTED})
                 WHERE category_id IS NOT NULL GROUP BY category_id"
            ),
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(oops)?;
    rows.collect::<rusqlite::Result<_>>().map_err(oops)
}

fn child_ids(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT id FROM categories WHERE parent_id = ?1")
        .map_err(oops)?;
    let rows = stmt.query_map(params![id], |r| r.get(0)).map_err(oops)?;
    rows.collect::<rusqlite::Result<_>>().map_err(oops)
}

fn category_kind(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row(
        "SELECT kind FROM categories WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()
    .map_err(oops)?
    .ok_or_else(|| "That category no longer exists.".to_string())
}

/// The single place transactions change hands. A `to` of `None` leaves them
/// uncategorised. Returns how many moved.
fn move_transactions(conn: &Connection, from: &[String], to: Option<&str>) -> Result<i64> {
    if from.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        "UPDATE transactions SET category_id = ? WHERE category_id IN ({})",
        placeholders(from.len())
    );
    let mut args: Vec<Option<String>> = vec![to.map(str::to_string)];
    args.extend(from.iter().map(|f| Some(f.clone())));
    let moved = conn
        .execute(&sql, params_from_iter(args.iter()))
        .map_err(oops)?;
    // A line item is filed under a category in its own right, so it moves with
    // the postings rather than being orphaned by a reassignment.
    let sql = format!(
        "UPDATE transaction_splits SET category_id = ? WHERE category_id IN ({})",
        placeholders(from.len())
    );
    conn.execute(&sql, params_from_iter(args.iter()))
        .map_err(oops)?;
    Ok(moved as i64)
}

/// Files every transaction sitting under `from` — and, when asked, under its
/// sub-categories — beneath `to` instead, leaving both categories in place.
pub fn reassign_category(
    conn: &Connection,
    from: &str,
    to: &str,
    include_children: bool,
) -> Result<i64> {
    let mut sources = vec![from.to_string()];
    if include_children {
        sources.extend(child_ids(conn, from)?);
    }
    if sources.iter().any(|s| s == to) {
        return Err("Pick a different category to move them to.".into());
    }
    if category_kind(conn, from)? != category_kind(conn, to)? {
        return Err("Income and expense categories can't be mixed.".into());
    }
    refuse_a_group(conn, Some(to))?;
    move_transactions(conn, &sources, Some(to))
}

/// Removes a category. Its transactions either move to `reassign_to` or fall
/// back to uncategorised, and its sub-categories go with it only when asked —
/// otherwise they are promoted to the top level.
pub fn delete_category(
    conn: &Connection,
    id: &str,
    reassign_to: Option<String>,
    delete_children: bool,
) -> Result<()> {
    refuse_a_group(conn, reassign_to.as_deref())?;
    let mut doomed = vec![id.to_string()];
    if delete_children {
        doomed.extend(child_ids(conn, id)?);
    }

    let target = match reassign_to.filter(|t| !t.is_empty()) {
        None => None,
        Some(target) => {
            if doomed.contains(&target) {
                return Err("Pick a category that isn't being deleted.".into());
            }
            if category_kind(conn, id)? != category_kind(conn, &target)? {
                return Err("Income and expense categories can't be mixed.".into());
            }
            Some(target)
        }
    };

    // Transactions move first: once the rows go, the foreign key has already
    // nulled the column and there is nothing left to point anywhere.
    move_transactions(conn, &doomed, target.as_deref())?;

    if !delete_children {
        // Promote any children rather than deleting them along with the group.
        conn.execute(
            "UPDATE categories SET parent_id = NULL WHERE parent_id = ?1",
            params![id],
        )
        .map_err(oops)?;
    }
    let sql = format!(
        "DELETE FROM categories WHERE id IN ({})",
        placeholders(doomed.len())
    );
    conn.execute(&sql, params_from_iter(doomed.iter()))
        .map_err(oops)?;
    Ok(())
}

// ------------------------------------------------------------ transactions

pub(crate) fn tx_from_row(r: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get(0)?,
        kind: r.get(1)?,
        amount: r.get(2)?,
        account_id: r.get(3)?,
        to_account_id: r.get(4)?,
        category_id: r.get(5)?,
        merchant: r.get(6)?,
        note: r.get(7)?,
        occurred_at: r.get(8)?,
        created_at: r.get(9)?,
        account_name: r.get(10)?,
        account_color: r.get(11)?,
        to_account_name: r.get(12)?,
        category_name: r.get(13)?,
        category_icon: r.get(14)?,
        category_color: r.get(15)?,
        category_group_id: r.get(16)?,
        category_group_name: r.get(17)?,
        refund_of: r.get(18)?,
        refund_of_merchant: r.get(19)?,
        refund_of_amount: r.get(20)?,
        refunded: r.get(21)?,
        cashback: r.get(22)?,
        cashback_set: r.get(23)?,
        cashback_cycle: r.get(24)?,
        pays_cashback: r.get::<_, i64>(25)? != 0,
        // Filled in by `attach_parts`: each is its own table, and reading
        // them per row would turn one list into three hundred queries.
        splits: Vec::new(),
        shares: Vec::new(),
        labels: Vec::new(),
        folders: Vec::new(),
    })
}

/// The line items and the shares belonging to a page of postings, fetched in
/// two queries however many rows are on screen and hung off the right ones.
pub(crate) fn attach_parts(conn: &Connection, rows: &mut [Transaction]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<&str> = rows.iter().map(|t| t.id.as_str()).collect();
    let ph = placeholders(ids.len());

    let sql = format!(
        "SELECT s.id, s.transaction_id, s.amount, s.category_id, s.note, s.sort_order,
                c.name, c.icon, c.color, COALESCE(p.id, c.id), COALESCE(p.name, c.name)
         FROM transaction_splits s
         LEFT JOIN categories c ON c.id = s.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         WHERE s.transaction_id IN ({ph})
         ORDER BY s.sort_order, s.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let splits = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok(TransactionSplit {
                id: r.get(0)?,
                transaction_id: r.get(1)?,
                amount: r.get(2)?,
                category_id: r.get(3)?,
                note: r.get(4)?,
                sort_order: r.get(5)?,
                category_name: r.get(6)?,
                category_icon: r.get(7)?,
                category_color: r.get(8)?,
                category_group_id: r.get(9)?,
                category_group_name: r.get(10)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let sql = format!(
        "SELECT d.transaction_id, d.id, d.direction, d.counterparty, d.principal,
                d.due_on, d.note, d.settled_at,
                COALESCE((SELECT SUM(p.amount) FROM debt_payments p WHERE p.debt_id = d.id), 0)
         FROM debts d
         WHERE d.from_split = 1 AND d.transaction_id IN ({ph})
         ORDER BY d.created_at"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let shares = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            let amount: Paise = r.get(4)?;
            let paid: Paise = r.get(8)?;
            let settled_at: Option<String> = r.get(7)?;
            // The bill's part of the debt, and only that. Anything lent on top
            // since is the debt's to show, not the bill's — and what comes
            // back pays off the oldest money first, which is this.
            let outstanding = (amount - paid).max(0);
            Ok((
                r.get::<_, String>(0)?,
                TransactionShare {
                    debt_id: r.get(1)?,
                    direction: r.get(2)?,
                    counterparty: r.get(3)?,
                    amount,
                    due_on: r.get(5)?,
                    note: r.get(6)?,
                    paid,
                    outstanding,
                    settled: settled_at.is_some() || outstanding == 0,
                },
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let sql = format!(
        "SELECT tl.transaction_id, l.id, l.name, l.color, l.silent
         FROM transaction_labels tl
         JOIN labels l ON l.id = tl.label_id
         WHERE tl.transaction_id IN ({ph})
         ORDER BY l.name"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let labels = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                TxLabel {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                    silent: r.get(4)?,
                },
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let sql = format!(
        "SELECT ft.transaction_id, f.id, f.name, f.color, f.icon
         FROM folder_transactions ft
         JOIN folders f ON f.id = ft.folder_id
         WHERE ft.transaction_id IN ({ph})
         ORDER BY f.name"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let in_folders = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                TxFolder {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                    icon: r.get(4)?,
                },
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    if splits.is_empty() && shares.is_empty() && labels.is_empty() && in_folders.is_empty() {
        return Ok(());
    }
    let at: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| (row.id.clone(), i))
        .collect();
    for split in splits {
        if let Some(&i) = at.get(&split.transaction_id) {
            rows[i].splits.push(split);
        }
    }
    for (tx_id, share) in shares {
        if let Some(&i) = at.get(&tx_id) {
            rows[i].shares.push(share);
        }
    }
    for (tx_id, label) in labels {
        if let Some(&i) = at.get(&tx_id) {
            rows[i].labels.push(label);
        }
    }
    for (tx_id, folder) in in_folders {
        if let Some(&i) = at.get(&tx_id) {
            rows[i].folders.push(folder);
        }
    }
    Ok(())
}

/// A typed amount as paise, when what was typed is only a number. Commas and
/// a rupee mark are allowed through, since that is how the app prints them.
fn rupees_to_paise(text: &str) -> Option<Paise> {
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, ',' | ' ' | '\u{20B9}'))
        .collect();
    if cleaned.is_empty() || !cleaned.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let (whole, frac) = cleaned.split_once('.').unwrap_or((cleaned.as_str(), ""));
    let whole: i64 = whole.parse().ok()?;
    let paise: i64 = match frac.len() {
        0 => 0,
        1 => frac.parse::<i64>().ok()? * 10,
        _ => frac.get(..2)?.parse().ok()?,
    };
    Some(whole * 100 + paise)
}

pub(crate) fn placeholders(n: usize) -> String {
    std::iter::repeat("?").take(n).collect::<Vec<_>>().join(",")
}

/// The WHERE clause and its arguments for a query, built once so that the rows
/// and the totals beside them can never disagree about what is being shown.
fn tx_filters(q: &TransactionQuery) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut wheres: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(s) = q.search.as_ref().filter(|s| !s.trim().is_empty()) {
        let term = s.trim();
        // `ta.name` matters as much as `a.name`: a transfer is most easily
        // found by where it went, and searching only the source side hides
        // every posting into an account from a search for that account.
        let mut clause =
            String::from("(t.merchant LIKE ? OR t.note LIKE ? OR a.name LIKE ? OR ta.name LIKE ? OR c.name LIKE ?");
        let like = format!("%{term}%");
        for _ in 0..5 {
            args.push(Box::new(like.clone()));
        }
        // A split bill's parts carry notes and categories of their own, and
        // "cab" written against one line of a dinner receipt has to be
        // findable — the line has no row in the ledger to be found by itself.
        clause.push_str(
            " OR EXISTS (SELECT 1 FROM transaction_splits s
                         LEFT JOIN categories sc ON sc.id = s.category_id
                         WHERE s.transaction_id = t.id
                           AND (s.note LIKE ? OR sc.name LIKE ?))",
        );
        for _ in 0..2 {
            args.push(Box::new(like.clone()));
        }
        // A bare number is almost always an amount — "15000" should find the
        // ₹15,000 SIP rather than nothing at all.
        if let Some(paise) = rupees_to_paise(term) {
            clause.push_str(" OR t.amount = ?");
            args.push(Box::new(paise));
        }
        clause.push(')');
        wheres.push(clause);
    }
    if let Some(kinds) = q.kinds.as_ref().filter(|v| !v.is_empty()) {
        wheres.push(format!("t.kind IN ({})", placeholders(kinds.len())));
        for k in kinds {
            args.push(Box::new(k.clone()));
        }
    }
    if let Some(ids) = q.account_ids.as_ref().filter(|v| !v.is_empty()) {
        let ph = placeholders(ids.len());
        // Which side of the posting to look at. It only tells transfers apart —
        // income and expenses touch one account — but for those it is the
        // difference between "money I moved out of savings" and "into it".
        let sides = match q.account_side.as_deref() {
            Some("from") => 1,
            Some("to") => 2,
            _ => 0,
        };
        wheres.push(match sides {
            1 => format!("t.account_id IN ({ph})"),
            2 => format!("t.to_account_id IN ({ph})"),
            _ => format!("(t.account_id IN ({ph}) OR t.to_account_id IN ({ph}))"),
        });
        for _ in 0..if sides == 0 { 2 } else { 1 } {
            for id in ids {
                args.push(Box::new(id.clone()));
            }
        }
    }
    if let Some(ids) = q.category_ids.as_ref().filter(|v| !v.is_empty()) {
        // A split bill belongs to every category it was filed against, so
        // filtering by one of them has to find the whole bill — the line item
        // has no existence of its own to return.
        let ph = placeholders(ids.len());
        wheres.push(format!(
            "(t.category_id IN ({ph}) OR EXISTS (SELECT 1 FROM transaction_splits s
                 WHERE s.transaction_id = t.id AND s.category_id IN ({ph})))"
        ));
        for _ in 0..2 {
            for id in ids {
                args.push(Box::new(id.clone()));
            }
        }
    }
    if let Some(ids) = q.exclude_category_ids.as_ref().filter(|v| !v.is_empty()) {
        // The opposite of the filter above, exactly: whatever it would find,
        // this leaves out — so a bill split across a hidden category goes,
        // and a posting with no category at all is never hidden by one.
        let ph = placeholders(ids.len());
        wheres.push(format!(
            "NOT (coalesce(t.category_id, '') IN ({ph}) OR EXISTS (SELECT 1 FROM transaction_splits s
                 WHERE s.transaction_id = t.id AND s.category_id IN ({ph})))"
        ));
        for _ in 0..2 {
            for id in ids {
                args.push(Box::new(id.clone()));
            }
        }
    }
    // A bill somebody else paid is one spent out of the Debts account; the
    // book holds that account's id in its settings.
    let theirs = "(t.kind = 'expense' AND t.account_id =
                   (SELECT value FROM settings WHERE key = 'debt_account'))";
    match q.paid_by.as_deref() {
        Some("others") => wheres.push(theirs.to_string()),
        Some("me") => wheres.push(format!("NOT coalesce({theirs}, 0)")),
        _ => {}
    }
    if let Some(ids) = q.label_ids.as_ref().filter(|v| !v.is_empty()) {
        let ph = placeholders(ids.len());
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM transaction_labels tl
                     WHERE tl.transaction_id = t.id AND tl.label_id IN ({ph}))"
        ));
        for id in ids {
            args.push(Box::new(id.clone()));
        }
    }
    if let Some(ids) = q.folder_ids.as_ref().filter(|v| !v.is_empty()) {
        let ph = placeholders(ids.len());
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM folder_transactions ft
                     WHERE ft.transaction_id = t.id AND ft.folder_id IN ({ph}))"
        ));
        for id in ids {
            args.push(Box::new(id.clone()));
        }
    }
    if let Some(from) = q.from.as_ref() {
        wheres.push("t.occurred_at >= ?".to_string());
        args.push(Box::new(from.clone()));
    }
    if let Some(to) = q.to.as_ref() {
        // `to` is an inclusive date; compare against the end of that day.
        wheres.push("t.occurred_at <= ?".to_string());
        args.push(Box::new(format!("{to}T23:59:59")));
    }

    let clause = if wheres.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", wheres.join(" AND "))
    };
    (clause, args)
}

pub fn list_transactions(conn: &Connection, q: TransactionQuery) -> Result<Vec<Transaction>> {
    let (clause, args) = tx_filters(&q);
    let mut sql = format!(
        "{}{TX_FROM}{clause} ORDER BY t.occurred_at DESC, t.created_at DESC",
        tx_select()
    );
    if let Some(limit) = q.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
        if let Some(offset) = q.offset {
            sql.push_str(&format!(" OFFSET {offset}"));
        }
    }

    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter().map(|b| b.as_ref())), tx_from_row)
        .map_err(oops)?;
    let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)?;
    attach_parts(conn, &mut rows)?;
    Ok(rows)
}

/// How many postings match, and what they come to. Deliberately ignores
/// `limit`: the list may be showing a page, but the totals above it describe
/// everything the filters select, not the slice that happens to be loaded.
pub fn transaction_summary(conn: &Connection, q: TransactionQuery) -> Result<TransactionSummary> {
    let (clause, args) = tx_filters(&q);
    // A refund and what it gave back cancel: the refund brings in nothing of
    // its own, and the posting it undoes cost that much less. The count still
    // counts every row, because every row is still there to be read.
    let sql = format!(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN t.kind = 'income'  AND {NOT_A_REFUND}
                                  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND {NOT_A_REFUND}
                                  THEN MAX(0, t.amount - {REFUNDED} - {SHARED} - {CASHBACK}) ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'transfer' THEN t.amount ELSE 0 END), 0)
         {TX_FROM}{clause}"
    );
    conn.query_row(
        &sql,
        params_from_iter(args.iter().map(|b| b.as_ref())),
        |r| {
            Ok(TransactionSummary {
                count: r.get(0)?,
                income: r.get(1)?,
                expense: r.get(2)?,
                transferred: r.get(3)?,
            })
        },
    )
    .map_err(oops)
}

pub fn get_transaction(conn: &Connection, id: &str) -> Result<Transaction> {
    let sql = format!("{}{TX_FROM} WHERE t.id = ?1", tx_select());
    let mut one = vec![conn
        .query_row(&sql, params![id], tx_from_row)
        .map_err(oops)?];
    attach_parts(conn, &mut one)?;
    Ok(one.remove(0))
}

/// Files a posting under several categories at once. The parts must come to
/// exactly what the posting is for: anything else and the ledger would say one
/// thing while the breakdown said another. An empty list clears the split and
/// leaves the posting filed under its own category again.
fn replace_splits(
    conn: &Connection,
    tx_id: &str,
    amount: Paise,
    kind: &str,
    splits: &[TransactionSplitInput],
) -> Result<()> {
    if !splits.is_empty() {
        if kind == "transfer" {
            return Err("Transfers move money between your own accounts, so there is nothing to split.".into());
        }
        if splits.len() < 2 {
            return Err("A split needs at least two parts.".into());
        }
        if splits.iter().any(|s| s.amount <= 0) {
            return Err("Every part of a split needs an amount greater than zero.".into());
        }
        for part in splits {
            refuse_a_group(conn, part.category_id.as_deref())?;
        }
        let total: Paise = splits.iter().map(|s| s.amount).sum();
        if total != amount {
            return Err(format!(
                "The parts come to ₹{} but the transaction is ₹{}.",
                total / 100,
                amount / 100
            ));
        }
    }

    // Rewritten wholesale rather than diffed: a split carries nothing worth
    // preserving across an edit — no payments, no history, just the shape the
    // form last showed.
    conn.execute(
        "DELETE FROM transaction_splits WHERE transaction_id = ?1",
        params![tx_id],
    )
    .map_err(oops)?;
    for (i, split) in splits.iter().enumerate() {
        conn.execute(
            "INSERT INTO transaction_splits (id, transaction_id, amount, category_id, note, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                new_id(),
                tx_id,
                split.amount,
                split.category_id.as_deref().filter(|c| !c.is_empty()),
                split.note.as_deref().map(str::trim).filter(|n| !n.is_empty()),
                i as i64
            ],
        )
        .map_err(oops)?;
    }
    Ok(())
}

/// Which way the people on a bill owe, held against who paid it.
///
/// A bill spent out of the Debts account is one somebody else paid: none of it
/// left an account of yours, so all of it is owed to them — a share running
/// the other way would turn what you owe into what you are owed, and a share
/// short of the bill would be spending nobody paid for. A bill you paid runs
/// the other way: the people on it owe you. Money that came in to you is yours
/// to hand back. And nothing comes in to the Debts account but what is owed,
/// so income never lands there.
///
/// The shares are the ones being saved, or the ones the posting already
/// carries when the save leaves them alone.
fn refuse_shares_running_the_wrong_way(
    conn: &Connection,
    id: Option<&str>,
    kind: &str,
    amount: Paise,
    account_id: &str,
    shares: Option<&[TransactionShareInput]>,
) -> Result<()> {
    let standing: Vec<(String, Paise)> = match (shares, id) {
        (Some(shares), _) => shares.iter().map(|s| (s.direction.clone(), s.amount)).collect(),
        (None, Some(id)) => {
            let mut stmt = conn
                .prepare(
                    "SELECT direction, principal FROM debts
                     WHERE transaction_id = ?1 AND from_split = 1",
                )
                .map_err(oops)?;
            let rows = stmt
                .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(oops)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(oops)?;
            rows
        }
        (None, None) => Vec::new(),
    };

    if debt_account_id(conn)?.as_deref() == Some(account_id) {
        if kind != "expense" {
            return Err(format!(
                "Pick the account the money came into — {DEBT_ACCOUNT} only stands for what is owed."
            ));
        }
        let owed: Paise = standing.iter().map(|(_, a)| a).sum();
        if standing.iter().any(|(d, _)| d != "borrowed") || owed != amount {
            return Err(
                "Somebody else paid this bill, so all of it is owed to them. Say who paid it."
                    .into(),
            );
        }
        return Ok(());
    }

    let wrong_way = if kind == "expense" { "borrowed" } else { "lent" };
    if standing.iter().any(|(d, _)| d == wrong_way) {
        return Err(if kind == "expense" {
            "You paid this bill, so the people on it owe you — not the other way round.".into()
        } else {
            "This money came in to you, so a share of it is yours to hand back, not theirs.".into()
        });
    }
    Ok(())
}

/// Turns the people on a bill into debts of their own. Each share is an
/// ordinary debt — it shows on the Debts screen, takes repayments and counts
/// towards net worth — that happens to know which posting opened it.
///
/// Shares already saved are matched by id and updated in place, so a
/// repayment recorded against one survives the bill being re-split. Debts
/// linked to this posting by hand are left alone: only the split's own are
/// its to remove.
fn replace_shares(
    conn: &Connection,
    tx_id: &str,
    amount: Paise,
    occurred_at: &str,
    merchant: &str,
    shares: &[TransactionShareInput],
) -> Result<()> {
    let opened_on = occurred_at.get(..10).unwrap_or(occurred_at).to_string();
    let mut kept: Vec<String> = Vec::new();

    if !shares.is_empty() {
        let total: Paise = shares.iter().map(|s| s.amount).sum();
        if total > amount {
            return Err(format!(
                "The shares come to ₹{} — more than the ₹{} bill.",
                total / 100,
                amount / 100
            ));
        }
    }

    for share in shares {
        let who = share.counterparty.trim();
        if who.is_empty() {
            return Err("Every share needs a name.".into());
        }
        if share.amount <= 0 {
            return Err(format!("{who}'s share needs an amount greater than zero."));
        }
        if share.direction != "lent" && share.direction != "borrowed" {
            return Err("A share is either lent or borrowed.".into());
        }
        // The column says the posting carries this debt, which it does either
        // way. This says whether it is one line of somebody's bill — a debt
        // entered on the debts screen writes its transfer through here too,
        // and it is nobody's share of anything.
        let from_split = share.from_split.unwrap_or(true);
        // A share with no note of its own says what it was for. A debt that
        // wrote its own posting is left to stand on its own name.
        let note = share
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .or_else(|| {
                if !from_split {
                    return None;
                }
                Some(if merchant.is_empty() {
                    "Share of a split bill".to_string()
                } else {
                    format!("Share of {merchant}")
                })
            });

        match share.id.as_deref() {
            // Only a share this posting already owns may be updated through
            // here; anything else would let a split quietly rewrite a debt
            // that was entered by hand.
            Some(id)
                if conn
                    .query_row(
                        "SELECT 1 FROM debts WHERE id = ?1 AND from_split = 1 AND transaction_id = ?2",
                        params![id, tx_id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(oops)?
                    .is_some() =>
            {
                conn.execute(
                    "UPDATE debts SET direction = ?2, counterparty = ?3, principal = ?4,
                            opened_on = ?5, due_on = ?6, note = ?7
                     WHERE id = ?1",
                    params![id, share.direction, who, share.amount, opened_on, share.due_on, note],
                )
                .map_err(oops)?;
                kept.push(id.to_string());
            }
            _ => {
                let id = new_id();
                conn.execute(
                    "INSERT INTO debts (id, direction, counterparty, principal, opened_on,
                                        due_on, note, settled_at, created_at, transaction_id, from_split)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, 1)",
                    params![
                        id,
                        share.direction,
                        who,
                        share.amount,
                        opened_on,
                        share.due_on,
                        note,
                        now(),
                        tx_id
                    ],
                )
                .map_err(oops)?;
                kept.push(id);
            }
        }
    }

    let sql = format!(
        "DELETE FROM debts WHERE from_split = 1 AND transaction_id = ?1
           AND id NOT IN ({})",
        placeholders(kept.len())
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(tx_id.to_string())];
    args.extend(
        kept.into_iter()
            .map(|id| Box::new(id) as Box<dyn rusqlite::ToSql>),
    );
    conn.execute(&sql, params_from_iter(args.iter().map(|b| b.as_ref())))
        .map_err(oops)?;
    Ok(())
}

/// What a refund is allowed to be, answered before anything is written.
///
/// A refund names one posting, runs the other way from it, and never gives
/// back more than was there — anything else and the two would not cancel,
/// which is the whole of what a refund is for. Chains are refused outright: a
/// refund of a refund is a thing nobody can read, and the netting would have
/// to guess which end of it counted.
///
/// Returns what should be stored, so a posting that names nothing simply
/// stops being a refund.
fn settle_refund(
    conn: &Connection,
    id: Option<&str>,
    kind: &str,
    amount: Paise,
    refund_of: Option<String>,
) -> Result<Option<String>> {
    // What this posting has had given back to it. It matters twice over: a
    // posting somebody has refunded cannot turn round and become a refund
    // itself, and it cannot be corrected down below what it gave back.
    if let Some(own) = id {
        let given_back: Paise = conn
            .query_row(
                "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE refund_of = ?1",
                params![own],
                |r| r.get(0),
            )
            .map_err(oops)?;
        if given_back > 0 {
            if refund_of.is_some() {
                return Err(
                    "Something already refunds this posting, so it cannot be a refund itself."
                        .into(),
                );
            }
            if amount < given_back {
                return Err(format!(
                    "₹{} of this has already been refunded, so it cannot be worth less than that.",
                    given_back / 100
                ));
            }
        }
    }

    let Some(target) = refund_of.filter(|t| !t.trim().is_empty()) else {
        return Ok(None);
    };
    if Some(target.as_str()) == id {
        return Err("A posting cannot refund itself.".into());
    }
    let (target_kind, target_amount, chained): (String, Paise, Option<String>) = conn
        .query_row(
            "SELECT kind, amount, refund_of FROM transactions WHERE id = ?1",
            params![&target],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "The posting this refunds is not in the book any more.".to_string())?;
    if chained.is_some() {
        return Err("That posting is itself a refund.".into());
    }
    // Only the two sides of the ledger have anything to give back: a transfer
    // moves money between your own accounts rather than earning or spending
    // it, so there is nothing to undo — on either side of the refund.
    let wants = match target_kind.as_str() {
        "expense" => "income",
        "income" => "expense",
        _ => {
            return Err(
                "A transfer moves money between your own accounts, so there is nothing to refund."
                    .into(),
            )
        }
    };
    if kind != wants {
        return Err(format!(
            "A refund of an {target_kind} is money going the other way, so it has to be {wants}."
        ));
    }
    // What is still standing on it: what it was for, less whatever earlier
    // refunds have already handed back. Its own earlier self doesn't count —
    // this save replaces it.
    let already: Paise = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions
             WHERE refund_of = ?1 AND id <> ?2",
            params![&target, id.unwrap_or("")],
            |r| r.get(0),
        )
        .map_err(oops)?;
    if amount + already > target_amount {
        return Err(format!(
            "That posting has ₹{} left to give back.",
            (target_amount - already) / 100
        ));
    }
    Ok(Some(target))
}

pub fn save_transaction(conn: &Connection, input: TransactionInput) -> Result<Transaction> {
    if input.amount <= 0 {
        return Err("Amount must be greater than zero.".into());
    }
    if input.kind == "transfer" {
        match input.to_account_id.as_deref() {
            // Money that left your accounts and is owed back is a transfer
            // with nowhere of yours to go: it is not spending, and the debt
            // standing against it is the other side of the entry. Without a
            // debt it is simply unaccounted for, so that is refused.
            None | Some("") => {
                let owed = match (input.shares.as_deref(), input.id.as_deref()) {
                    (Some(shares), _) => !shares.is_empty(),
                    (None, Some(id)) => conn
                        .query_row(
                            "SELECT COUNT(*) FROM debts
                             WHERE from_split = 1 AND transaction_id = ?1",
                            params![id],
                            |r| r.get::<_, i64>(0),
                        )
                        .map_err(oops)?
                        > 0,
                    (None, None) => false,
                };
                if !owed {
                    return Err(
                        "Pick an account to transfer into, or say who owes it back.".into(),
                    );
                }
            }
            Some(to) if to == input.account_id => {
                return Err("A transfer needs two different accounts.".into())
            }
            _ => {}
        }
    }
    // Which way the debt against this posting runs, if one does — read before
    // the input is taken apart below.
    let debt_side = if input.kind == "transfer" {
        debt_side(conn, &input)?
    } else {
        None
    };

    // Transfers move money between your own accounts, so they are never
    // categorised — clear anything the form left behind.
    let category_id = if input.kind == "transfer" {
        None
    } else {
        input.category_id.filter(|c| !c.is_empty())
    };
    refuse_a_group(conn, category_id.as_deref())?;
    let refund_of = settle_refund(
        conn,
        input.id.as_deref(),
        &input.kind,
        input.amount,
        input.refund_of.clone(),
    )?;
    let to_account_id = if input.kind == "transfer" {
        input.to_account_id.clone().filter(|to| !to.is_empty())
    } else {
        None
    };
    // What the card gave back, when it was said by hand rather than left to
    // the card's rate — a spend the offer excludes, or a figure off the
    // statement. Only a purchase earns anything, and none earns back more
    // than it cost.
    let cashback_set = match input.cashback {
        Some(back) if input.kind == "expense" => {
            if back < 0 || back > input.amount {
                return Err("Cashback can be anything from nothing up to what was paid.".into());
            }
            Some(back)
        }
        _ => None,
    };

    // Every debt runs through one account. Money handed to somebody has not
    // left your books — it is out with them — so a transfer with a debt
    // standing against it and nowhere of yours to go lands in the account
    // that stands for what is out with people, the same one repayments come
    // back through. Money borrowed runs the other way: in from that account
    // and into the one it arrived in.
    //
    // Filled in here rather than asked for, because there is only ever one
    // answer, and a posting whose other side is nothing is a posting the
    // balance sheet cannot read.
    let mut account_id = input.account_id.clone();
    let mut to_account_id = to_account_id;
    if input.kind == "transfer" && to_account_id.is_none() {
        if let Some(direction) = debt_side {
            let holding = debt_account(conn)?;
            if holding == account_id {
                return Err(format!(
                    "Pick the account the money actually moved through — {DEBT_ACCOUNT} is the other side of it."
                ));
            }
            if direction == "borrowed" {
                to_account_id = Some(account_id);
                account_id = holding;
            } else {
                to_account_id = Some(holding);
            }
        }
    }
    // A bill somebody else paid touched no account of yours either: named
    // against none, and owed in full to whoever paid it, it is spent out of the
    // same account — the one answer there is, filled in the same way.
    let owed_to_them = input
        .shares
        .as_deref()
        .is_some_and(|s| !s.is_empty() && s.iter().all(|s| s.direction == "borrowed"));
    if input.kind == "expense" && account_id.is_empty() && owed_to_them {
        account_id = debt_account(conn)?;
    }
    if account_id.is_empty() {
        return Err("Pick an account.".into());
    }
    if input.kind != "transfer" {
        refuse_shares_running_the_wrong_way(
            conn,
            input.id.as_deref(),
            &input.kind,
            input.amount,
            &account_id,
            input.shares.as_deref(),
        )?;
    }

    // One transaction over the whole save: a bill and the parts it was split
    // into are one fact, and half of it landing would leave the two
    // disagreeing. Unless a caller — the statement importer, saving many
    // postings as one act — has a transaction open already, whose fate
    // covers this save too.
    let guard = if conn.is_autocommit() {
        Some(conn.unchecked_transaction().map_err(oops)?)
    } else {
        None
    };

    let id = match input.id {
        Some(id) => {
            conn.execute(
                "UPDATE transactions SET kind = ?2, amount = ?3, account_id = ?4,
                        to_account_id = ?5, category_id = ?6, merchant = ?7, note = ?8,
                        occurred_at = ?9, refund_of = ?10, cashback_set = ?11
                 WHERE id = ?1",
                params![
                    id,
                    input.kind,
                    input.amount,
                    account_id,
                    to_account_id,
                    category_id,
                    input.merchant,
                    input.note,
                    input.occurred_at,
                    refund_of,
                    cashback_set
                ],
            )
            .map_err(oops)?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO transactions (id, kind, amount, account_id, to_account_id,
                                           category_id, merchant, note, occurred_at,
                                           created_at, refund_of, cashback_set)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    id,
                    input.kind,
                    input.amount,
                    account_id,
                    to_account_id,
                    category_id,
                    input.merchant,
                    input.note,
                    input.occurred_at,
                    now(),
                    refund_of,
                    cashback_set
                ],
            )
            .map_err(oops)?;
            id
        }
    };

    // A split that no longer describes its posting has to go: turning an
    // expense into a transfer leaves nothing to divide, and changing the
    // amount from anywhere that doesn't send the parts leaves them adding up
    // to the old figure. Either way the breakdown would contradict the ledger.
    if input.splits.is_none() {
        let stale: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 AND COALESCE(SUM(amount), 0) <> ?2
                 FROM transaction_splits WHERE transaction_id = ?1",
                params![id, input.amount],
                |r| r.get::<_, i64>(0),
            )
            .map_err(oops)?
            != 0;
        if stale || input.kind == "transfer" {
            conn.execute(
                "DELETE FROM transaction_splits WHERE transaction_id = ?1",
                params![id],
            )
            .map_err(oops)?;
        }
    }
    if let Some(splits) = input.splits.as_deref() {
        replace_splits(conn, &id, input.amount, &input.kind, splits)?;
    }
    if let Some(shares) = input.shares.as_deref() {
        replace_shares(
            conn,
            &id,
            input.amount,
            &input.occurred_at,
            input.merchant.trim(),
            shares,
        )?;
    }

    // The labels it should wear, replaced as a set. `None` touches nothing,
    // so every caller that doesn't know about labels leaves them alone.
    if let Some(label_ids) = input.label_ids.as_deref() {
        conn.execute(
            "DELETE FROM transaction_labels WHERE transaction_id = ?1",
            params![id],
        )
        .map_err(oops)?;
        for label in label_ids {
            conn.execute(
                "INSERT OR IGNORE INTO transaction_labels (transaction_id, label_id)
                 VALUES (?1, ?2)",
                params![id, label],
            )
            .map_err(oops)?;
        }
    }

    if let Some(guard) = guard {
        guard.commit().map_err(oops)?;
    }
    get_transaction(conn, &id)
}

/// Applies one change to many postings.
///
/// Every rule the single form enforces holds here too, and a posting the
/// change cannot apply to is left alone rather than bent to fit: a transfer
/// has no category, a category belongs to one side of the ledger, and a bill
/// already split into parts takes its category from the largest of them
/// rather than from anything set on the row. Those come back as `skipped`,
/// so the screen can say so instead of quietly doing less than it claimed.
pub fn update_transactions(
    conn: &Connection,
    ids: &[String],
    patch: TransactionPatch,
) -> Result<BulkResult> {
    if ids.is_empty() {
        return Ok(BulkResult { changed: 0, skipped: 0 });
    }
    let clear_category = patch.clear_category.unwrap_or(false);
    let category_id = patch.category_id.filter(|c| !c.is_empty());
    // The side of the ledger the category sits on: an expense cannot be filed
    // under an income category without the totals going wrong.
    refuse_a_group(conn, category_id.as_deref())?;
    let category_kind: Option<String> = match &category_id {
        Some(id) => Some(
            conn.query_row("SELECT kind FROM categories WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(oops)?
            .ok_or("That category no longer exists.")?,
        ),
        None => None,
    };
    let account_id = patch.account_id.filter(|a| !a.is_empty());
    if let Some(id) = &account_id {
        // Reusing the existing check: it errors if the account is gone.
        account_kind(conn, id)?;
    }
    let merchant = patch.merchant.map(|m| m.trim().to_string());
    let clear_note = patch.clear_note.unwrap_or(false);

    let guard = conn.unchecked_transaction().map_err(oops)?;
    let mut changed = 0;
    let mut skipped = 0;

    for id in ids {
        let row: Option<(String, Option<String>, Option<String>, i64)> = conn
            .query_row(
                "SELECT t.kind, t.account_id, t.to_account_id,
                        (SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id = t.id)
                 FROM transactions t WHERE t.id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(oops)?;
        let Some((kind, _from, to_account, parts)) = row else {
            skipped += 1;
            continue;
        };

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut refused = false;

        if clear_category || category_id.is_some() {
            let allowed = kind != "transfer"
                && parts == 0
                && category_kind.as_deref().is_none_or(|c| c == kind);
            if allowed {
                sets.push("category_id = ?");
                args.push(Box::new(if clear_category { None } else { category_id.clone() }));
            } else {
                refused = true;
            }
        }
        if let Some(account) = &account_id {
            // Moving a transfer onto the account it already pays into would
            // leave it moving money to itself.
            if to_account.as_deref() == Some(account.as_str()) {
                refused = true;
            } else {
                sets.push("account_id = ?");
                args.push(Box::new(account.clone()));
            }
        }
        if let Some(name) = &merchant {
            sets.push("merchant = ?");
            args.push(Box::new(name.clone()));
        }
        if clear_note {
            sets.push("note = ?");
            args.push(Box::new(None::<String>));
        } else if let Some(note) = &patch.note {
            sets.push("note = ?");
            args.push(Box::new(note.trim().to_string()));
        }

        if sets.is_empty() {
            if refused {
                skipped += 1;
            }
            continue;
        }
        args.push(Box::new(id.clone()));
        let sql = format!("UPDATE transactions SET {} WHERE id = ?", sets.join(", "));
        conn.execute(&sql, params_from_iter(args.iter().map(|a| a.as_ref())))
            .map_err(oops)?;
        if refused {
            skipped += 1;
        } else {
            changed += 1;
        }
    }

    guard.commit().map_err(oops)?;
    Ok(BulkResult { changed, skipped })
}

/// Deletes a run of postings, and whatever they alone were holding up.
pub fn delete_transactions(conn: &Connection, ids: &[String]) -> Result<i64> {
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let mut gone = 0;
    for id in ids {
        gone += conn
            .execute("DELETE FROM transactions WHERE id = ?1", params![id])
            .map_err(oops)? as i64;
    }
    guard.commit().map_err(oops)?;
    Ok(gone)
}

pub fn delete_transaction(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM transactions WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

// ------------------------------------------------------------------ templates

/// One template with the names its three references stand for, so a list of
/// them reads without a second round-trip — exactly as a posting's does.
const TEMPLATE_SELECT: &str = "
SELECT t.id, t.name, t.kind, t.amount, t.account_id, t.to_account_id, t.category_id,
       t.merchant, t.note, t.used_count, t.last_used_at, t.created_at,
       a.name, a.color, ta.name, c.name, c.icon, c.color
FROM transaction_templates t
LEFT JOIN accounts a ON a.id = t.account_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
LEFT JOIN categories c ON c.id = t.category_id
";

fn template_row(r: &Row) -> rusqlite::Result<TxTemplate> {
    Ok(TxTemplate {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        amount: r.get(3)?,
        account_id: r.get(4)?,
        to_account_id: r.get(5)?,
        category_id: r.get(6)?,
        merchant: r.get(7)?,
        note: r.get(8)?,
        used_count: r.get(9)?,
        last_used_at: r.get(10)?,
        created_at: r.get(11)?,
        account_name: r.get(12)?,
        account_color: r.get(13)?,
        to_account_name: r.get(14)?,
        category_name: r.get(15)?,
        category_icon: r.get(16)?,
        category_color: r.get(17)?,
        splits: Vec::new(),
        labels: Vec::new(),
    })
}

/// Fills in the parts and the pins for a set of templates already read.
fn hydrate_templates(conn: &Connection, rows: &mut [TxTemplate]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let index: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.clone(), i))
        .collect();
    // Owned rather than borrowed: the parts are pushed back into `rows` below,
    // and a borrow of it could not still be open when that happens.
    let ids: Vec<String> = rows.iter().map(|t| t.id.clone()).collect();
    let ph = placeholders(ids.len());

    let sql = format!(
        "SELECT s.id, s.template_id, s.amount, s.category_id, s.note, s.sort_order,
                c.name, c.icon, c.color
         FROM template_splits s
         LEFT JOIN categories c ON c.id = s.category_id
         WHERE s.template_id IN ({ph})
         ORDER BY s.sort_order, s.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let splits = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok(TemplateSplit {
                id: r.get(0)?,
                template_id: r.get(1)?,
                amount: r.get(2)?,
                category_id: r.get(3)?,
                note: r.get(4)?,
                sort_order: r.get(5)?,
                category_name: r.get(6)?,
                category_icon: r.get(7)?,
                category_color: r.get(8)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    for split in splits {
        if let Some(&i) = index.get(&split.template_id) {
            rows[i].splits.push(split);
        }
    }

    let sql = format!(
        "SELECT tl.template_id, l.id, l.name, l.color, l.silent
         FROM template_labels tl
         JOIN labels l ON l.id = tl.label_id
         WHERE tl.template_id IN ({ph})
         ORDER BY l.name"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let labels = stmt
        .query_map(params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                TxLabel {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                    silent: r.get(4)?,
                },
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    for (template_id, label) in labels {
        if let Some(&i) = index.get(&template_id) {
            rows[i].labels.push(label);
        }
    }
    Ok(())
}

/// Every template, what you reach for most at the top. A template made and
/// never used yet sorts by the day it was made, so it is where you left it.
pub fn list_templates(conn: &Connection) -> Result<Vec<TxTemplate>> {
    let sql = format!("{TEMPLATE_SELECT} ORDER BY COALESCE(t.last_used_at, t.created_at) DESC, t.name");
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let mut rows = stmt
        .query_map([], |r| template_row(r))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);
    hydrate_templates(conn, &mut rows)?;
    Ok(rows)
}

pub fn get_template(conn: &Connection, id: &str) -> Result<TxTemplate> {
    let sql = format!("{TEMPLATE_SELECT} WHERE t.id = ?1");
    let mut rows = vec![conn
        .query_row(&sql, params![id], |r| template_row(r))
        .map_err(|_| "That template is not there any more.".to_string())?];
    hydrate_templates(conn, &mut rows)?;
    Ok(rows.remove(0))
}

/// Writes a template whole: what it says, the parts it is filed under, and the
/// labels it pins. There is nothing half-saved to leave alone, so unlike a
/// posting every save replaces the lot.
pub fn save_template(conn: &Connection, input: TxTemplateInput) -> Result<TxTemplate> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("A template needs a name.".into());
    }
    if !matches!(input.kind.as_str(), "income" | "expense" | "transfer") {
        return Err("A template has to be an income, an expense or a transfer.".into());
    }
    if input.amount < 0 {
        return Err("An amount cannot be negative.".into());
    }
    let transfer = input.kind == "transfer";
    let category_id = if transfer {
        None
    } else {
        input.category_id.filter(|c| !c.is_empty())
    };
    refuse_a_group(conn, category_id.as_deref())?;
    let account_id = input.account_id.filter(|a| !a.is_empty());
    let to_account_id = if transfer {
        input.to_account_id.filter(|a| !a.is_empty())
    } else {
        None
    };
    if transfer && to_account_id.is_some() && to_account_id == account_id {
        return Err("A transfer needs two different accounts.".into());
    }

    let splits = input.splits.unwrap_or_default();
    if !splits.is_empty() {
        if transfer {
            return Err(
                "Transfers move money between your own accounts, so there is nothing to split."
                    .into(),
            );
        }
        if splits.len() < 2 {
            return Err("A split needs at least two parts.".into());
        }
        if splits.iter().any(|s| s.amount <= 0) {
            return Err("Every part of a split needs an amount greater than zero.".into());
        }
        // The parts are what make up the amount, so a template that divides a
        // bill has to say what the bill comes to. Change the figure when you
        // use it and the last part takes the difference, as it does anywhere.
        let total: Paise = splits.iter().map(|s| s.amount).sum();
        if total != input.amount {
            return Err(format!(
                "The parts come to ₹{} but the template is ₹{}.",
                total / 100,
                input.amount / 100
            ));
        }
        for part in &splits {
            refuse_a_group(conn, part.category_id.as_deref())?;
        }
    }

    let taken = |e: rusqlite::Error| {
        if e.to_string().contains("UNIQUE") {
            format!("There is already a template called \"{name}\".")
        } else {
            e.to_string()
        }
    };

    let guard = conn.unchecked_transaction().map_err(oops)?;
    let id = match input.id.filter(|i| !i.is_empty()) {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE transaction_templates
                        SET name = ?2, kind = ?3, amount = ?4, account_id = ?5,
                            to_account_id = ?6, category_id = ?7, merchant = ?8, note = ?9
                      WHERE id = ?1",
                    params![
                        id,
                        name,
                        input.kind,
                        input.amount,
                        account_id,
                        to_account_id,
                        category_id,
                        input.merchant.trim(),
                        input.note.as_deref().map(str::trim).filter(|n| !n.is_empty()),
                    ],
                )
                .map_err(taken)?;
            if changed == 0 {
                return Err("That template is not there any more.".into());
            }
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO transaction_templates
                    (id, name, kind, amount, account_id, to_account_id, category_id,
                     merchant, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    name,
                    input.kind,
                    input.amount,
                    account_id,
                    to_account_id,
                    category_id,
                    input.merchant.trim(),
                    input.note.as_deref().map(str::trim).filter(|n| !n.is_empty()),
                    now()
                ],
            )
            .map_err(taken)?;
            id
        }
    };

    conn.execute(
        "DELETE FROM template_splits WHERE template_id = ?1",
        params![id],
    )
    .map_err(oops)?;
    for (i, split) in splits.iter().enumerate() {
        conn.execute(
            "INSERT INTO template_splits (id, template_id, amount, category_id, note, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                new_id(),
                id,
                split.amount,
                split.category_id.as_deref().filter(|c| !c.is_empty()),
                split.note.as_deref().map(str::trim).filter(|n| !n.is_empty()),
                i as i64
            ],
        )
        .map_err(oops)?;
    }

    conn.execute(
        "DELETE FROM template_labels WHERE template_id = ?1",
        params![id],
    )
    .map_err(oops)?;
    for label in input.label_ids.unwrap_or_default() {
        conn.execute(
            "INSERT OR IGNORE INTO template_labels (template_id, label_id) VALUES (?1, ?2)",
            params![id, label],
        )
        .map_err(oops)?;
    }
    guard.commit().map_err(oops)?;
    get_template(conn, &id)
}

/// The template goes. Every posting written from it stays: what a template
/// left behind is an entry in the ledger, and it belongs to the ledger.
pub fn delete_template(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM transaction_templates WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

/// Counts one posting written from a template, so the list keeps what you
/// actually reach for near the top. Called once the posting is saved rather
/// than when the form is filled: a template you opened and thought better of
/// was never used.
pub fn touch_template(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE transaction_templates
            SET used_count = used_count + 1, last_used_at = ?2
          WHERE id = ?1",
        params![id, now()],
    )
    .map_err(oops)?;
    Ok(())
}

// ------------------------------------------------ labels & statement import

/// The label the importer pins on whatever it brings in: the queue of
/// postings waiting for a person to say the guess was right.
pub const TRIAGE_LABEL: &str = "Triage";
const TRIAGE_COLOR: &str = "#F0B429";

pub fn list_labels(conn: &Connection) -> Result<Vec<Label>> {
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.name, l.color,
                    (SELECT COUNT(*) FROM transaction_labels tl WHERE tl.label_id = l.id),
                    l.silent
             FROM labels l ORDER BY l.name",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Label {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                count: r.get(3)?,
                silent: r.get(4)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

pub fn save_label(conn: &Connection, input: LabelInput) -> Result<Label> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("A label needs a name.".into());
    }
    let taken = |e: rusqlite::Error| {
        if e.to_string().contains("UNIQUE") {
            format!("There is already a label called \"{name}\".")
        } else {
            e.to_string()
        }
    };
    let id = match input.id.filter(|i| !i.is_empty()) {
        Some(id) => {
            conn.execute(
                "UPDATE labels SET name = ?2, color = ?3, silent = ?4 WHERE id = ?1",
                params![id, name, input.color, input.silent],
            )
            .map_err(taken)?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO labels (id, name, color, silent, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, name, input.color, input.silent, now()],
            )
            .map_err(taken)?;
            id
        }
    };
    conn.query_row(
        "SELECT l.id, l.name, l.color,
                (SELECT COUNT(*) FROM transaction_labels tl WHERE tl.label_id = l.id),
                l.silent
         FROM labels l WHERE l.id = ?1",
        params![id],
        |r| {
            Ok(Label {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                count: r.get(3)?,
                silent: r.get(4)?,
            })
        },
    )
    .map_err(oops)
}

/// The label goes, and comes off every posting wearing it. The postings
/// themselves are untouched — a label is a pin, not a filing.
pub fn delete_label(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM labels WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

fn ensure_label(conn: &Connection, name: &str, color: &str) -> Result<String> {
    if let Some(id) = conn
        .query_row("SELECT id FROM labels WHERE name = ?1", params![name], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(oops)?
    {
        return Ok(id);
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO labels (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, color, now()],
    )
    .map_err(oops)?;
    Ok(id)
}

/// The label a spoken posting wears for good — not a queue like Triage, but
/// a note of where it came from. Confirming a capture clears Triage and
/// leaves this one on, which is what makes "everything I said out loud"
/// answerable months later.
pub const SIRI_LABEL: &str = "Siri";
const SIRI_COLOR: &str = "#EC4899";

/// Pins a label on a posting, making it if this book has never had one. The
/// colour is only used for a label that has to be created: one you have made
/// yourself keeps whatever colour you gave it.
pub fn pin_label(conn: &Connection, transaction_id: &str, name: &str, color: &str) -> Result<()> {
    let label_id = ensure_label(conn, name, color)?;
    conn.execute(
        "INSERT OR IGNORE INTO transaction_labels (transaction_id, label_id)
         VALUES (?1, ?2)",
        params![transaction_id, label_id],
    )
    .map_err(oops)?;
    Ok(())
}

/// A spoken posting wears Siri, and keeps it.
pub fn pin_siri(conn: &Connection, transaction_id: &str) -> Result<()> {
    pin_label(conn, transaction_id, SIRI_LABEL, SIRI_COLOR)
}

/// Writes one counterparty's filing down as confirmed — what the next
/// statement of them should become, no questions asked.
fn remember_rule(
    conn: &Connection,
    key: &str,
    kind: &str,
    category_id: Option<&str>,
    from_account: Option<&str>,
    to_account: Option<&str>,
    merchant: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO import_rules
             (id, match_key, kind, category_id, from_account_id, to_account_id,
              merchant, confirmed, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)
         ON CONFLICT(match_key) DO UPDATE SET
             kind = excluded.kind,
             category_id = excluded.category_id,
             from_account_id = excluded.from_account_id,
             to_account_id = excluded.to_account_id,
             merchant = excluded.merchant,
             confirmed = 1,
             updated_at = excluded.updated_at",
        params![new_id(), key, kind, category_id, from_account, to_account, merchant, now()],
    )
    .map_err(oops)?;
    Ok(())
}

/// A statement row's side of the ledger, seen from one account: money out of
/// it is a debit whatever kind of posting carried it.
fn posting_direction(kind: &str, account_id: &str, target: &str) -> &'static str {
    match kind {
        "income" => "credit",
        "expense" => "debit",
        _ => {
            if account_id == target {
                "debit"
            } else {
                "credit"
            }
        }
    }
}

/// What the importer remembers about one counterparty.
struct ImportRule {
    kind: String,
    category_id: Option<String>,
    from_account_id: Option<String>,
    to_account_id: Option<String>,
    merchant: String,
    confirmed: bool,
}

/// Holds every statement row against the book. A row that pairs with an
/// existing posting — same amount, same side, dates within a few days of each
/// other, nearest first — is already recorded; the rest are new, and each
/// arrives with the best available guess at how to file it.
pub fn preview_import(
    conn: &Connection,
    account_id: &str,
    rows: Vec<StatementRow>,
) -> Result<Vec<ImportPreviewRow>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let parse_day = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(oops);
    let mut lo = parse_day(&rows[0].date)?;
    let mut hi = lo;
    for row in &rows {
        let day = parse_day(&row.date)?;
        lo = lo.min(day);
        hi = hi.max(day);
    }

    // Every posting touching the account across the statement's stretch,
    // widened by the matching window so edges pair as well as middles.
    struct Candidate {
        id: String,
        day: NaiveDate,
        amount: Paise,
        direction: &'static str,
        summary: String,
        free: bool,
    }
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.kind, t.amount, t.account_id, t.occurred_at,
                    t.merchant, c.name
             FROM transactions t
             LEFT JOIN categories c ON c.id = t.category_id
             WHERE (t.account_id = ?1 OR t.to_account_id = ?1)
               AND t.occurred_at >= ?2 AND t.occurred_at <= ?3",
        )
        .map_err(oops)?;
    let mut candidates: Vec<Candidate> = stmt
        .query_map(
            params![
                account_id,
                (lo - Duration::days(6)).to_string(),
                format!("{}T23:59:59", hi + Duration::days(6)),
            ],
            |r| {
                let kind: String = r.get(1)?;
                let from: String = r.get(3)?;
                let occurred: String = r.get(4)?;
                let merchant: String = r.get(5)?;
                let category: Option<String> = r.get(6)?;
                Ok((r.get::<_, String>(0)?, kind, r.get::<_, Paise>(2)?, from, occurred, merchant, category))
            },
        )
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?
        .into_iter()
        .filter_map(|(id, kind, amount, from, occurred, merchant, category)| {
            let day = NaiveDate::parse_from_str(occurred.get(..10)?, "%Y-%m-%d").ok()?;
            let what = category.unwrap_or_else(|| kind.clone());
            let summary = if merchant.is_empty() {
                what
            } else {
                format!("{merchant} · {what}")
            };
            Some(Candidate {
                id,
                day,
                amount,
                direction: posting_direction(&kind, &from, account_id),
                summary,
                free: true,
            })
        })
        .collect();

    let mut stmt = conn
        .prepare(
            "SELECT match_key, kind, category_id, from_account_id, to_account_id,
                    merchant, confirmed
             FROM import_rules",
        )
        .map_err(oops)?;
    let rules: HashMap<String, ImportRule> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                ImportRule {
                    kind: r.get(1)?,
                    category_id: r.get(2)?,
                    from_account_id: r.get(3)?,
                    to_account_id: r.get(4)?,
                    merchant: r.get(5)?,
                    confirmed: r.get::<_, i64>(6)? != 0,
                },
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(oops)?;

    // Nearest-date greedy pairing, widening the window pass by pass so an
    // exact-day match is never stolen by a row three days out.
    let days: Vec<NaiveDate> = rows
        .iter()
        .map(|r| parse_day(&r.date))
        .collect::<Result<_>>()?;
    let mut matched: Vec<Option<usize>> = vec![None; rows.len()];
    for window in [0i64, 1, 3, 5] {
        for (i, row) in rows.iter().enumerate() {
            if matched[i].is_some() {
                continue;
            }
            let mut best: Option<(i64, usize)> = None;
            for (j, cand) in candidates.iter().enumerate() {
                if !cand.free || cand.amount != row.amount || cand.direction != row.direction {
                    continue;
                }
                let delta = (cand.day - days[i]).num_days().abs();
                if delta <= window && best.is_none_or(|(d, _)| delta < d) {
                    best = Some((delta, j));
                }
            }
            if let Some((_, j)) = best {
                candidates[j].free = false;
                matched[i] = Some(j);
            }
        }
    }

    let out = rows
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            if let Some(j) = matched[i] {
                let cand = &candidates[j];
                return ImportPreviewRow {
                    kind: row.direction.clone(),
                    status: "matched".into(),
                    matched_id: Some(cand.id.clone()),
                    matched_summary: Some(cand.summary.clone()),
                    matched_on: Some(cand.day.to_string()),
                    category_id: None,
                    transfer_account_id: None,
                    merchant: String::new(),
                    from_rule: false,
                    rule_confirmed: false,
                    match_key: None,
                    row,
                };
            }
            let fallback_kind = if row.direction == "debit" { "expense" } else { "income" };
            let key = crate::import::match_key(&row.narration);
            let rule = key
                .as_deref()
                .and_then(|key| rules.get(key))
                // A transfer rule names both of its ends; it only fits an
                // import that lands on one of them.
                .filter(|rule| {
                    rule.kind != "transfer"
                        || rule.from_account_id.as_deref() == Some(account_id)
                        || rule.to_account_id.as_deref() == Some(account_id)
                });
            let (kind, category_id, transfer_account_id, merchant, from_rule, confirmed) =
                match rule {
                    Some(rule) => (
                        rule.kind.clone(),
                        rule.category_id.clone(),
                        if rule.kind == "transfer" {
                            if rule.from_account_id.as_deref() == Some(account_id) {
                                rule.to_account_id.clone()
                            } else {
                                rule.from_account_id.clone()
                            }
                        } else {
                            None
                        },
                        if rule.merchant.is_empty() {
                            crate::import::display_merchant(&row.narration)
                        } else {
                            rule.merchant.clone()
                        },
                        true,
                        rule.confirmed,
                    ),
                    None => (
                        fallback_kind.to_string(),
                        None,
                        None,
                        crate::import::display_merchant(&row.narration),
                        false,
                        false,
                    ),
                };
            ImportPreviewRow {
                status: "new".into(),
                matched_id: None,
                matched_summary: None,
                matched_on: None,
                kind,
                category_id,
                transfer_account_id,
                merchant,
                from_rule,
                rule_confirmed: confirmed,
                match_key: key,
                row,
            }
        })
        .collect();
    Ok(out)
}

/// Writes the agreed rows into the book, each wearing the Triage label when
/// asked to, all inside one transaction — a half-imported statement is worse
/// than none.
///
/// A row marked `affects_balance: false` is one the current balance already
/// reflects — a gap being filled in for the record. It is written down like
/// any other, and every opening balance it touches moves the same amount the
/// other way, so no balance anywhere changes. Which rows those are is the
/// caller's to say: nothing about a statement reveals what was already
/// counted.
pub fn commit_import(
    conn: &Connection,
    account_id: &str,
    rows: Vec<ImportCommitRow>,
) -> Result<ImportResult> {
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let triage_id = ensure_label(conn, TRIAGE_LABEL, TRIAGE_COLOR)?;
    let mut inserted = 0i64;
    let mut triaged = 0i64;
    let mut balance_neutral = 0i64;
    let mut debts = 0i64;
    let mut adjustments: HashMap<String, Paise> = HashMap::new();

    for ImportCommitRow { row, mut input, triage, learn, affects_balance } in rows {
        // The posting goes through the same door a hand-written one does —
        // one set of validations, splits and shares included. A statement
        // row is always a new posting, whatever id a form left on the input.
        input.id = None;
        // The user's own words when they wrote any; the bank's otherwise.
        if input.note.as_deref().map_or(true, |n| n.trim().is_empty()) {
            input.note = Some(row.narration.trim().to_string()).filter(|n| !n.is_empty());
        }
        let tx = save_transaction(conn, input)?;
        conn.execute(
            "UPDATE transactions SET import_key = ?1 WHERE id = ?2",
            params![crate::import::match_key(&row.narration), tx.id],
        )
        .map_err(oops)?;
        inserted += 1;
        debts += tx.shares.len() as i64;

        // A filing shaped by hand in the review is as reviewed as it gets:
        // it skips triage, so the rule it would have taught on confirm gets
        // written down here instead.
        if learn {
            if let Some(key) = crate::import::match_key(&row.narration) {
                let is_transfer = tx.kind == "transfer";
                remember_rule(
                    conn,
                    &key,
                    &tx.kind,
                    tx.category_id.as_deref(),
                    Some(tx.account_id.as_str()).filter(|_| is_transfer),
                    tx.to_account_id.as_deref().filter(|_| is_transfer),
                    &tx.merchant,
                )?;
            }
        }

        // Already counted: cancel what this posting does to each balance by
        // moving the openings the other way, whichever accounts it touched.
        if !affects_balance {
            balance_neutral += 1;
            match tx.kind.as_str() {
                "expense" => {
                    *adjustments.entry(tx.account_id.clone()).or_default() += tx.amount;
                }
                "income" => {
                    *adjustments.entry(tx.account_id.clone()).or_default() -= tx.amount;
                }
                _ => {
                    *adjustments.entry(tx.account_id.clone()).or_default() += tx.amount;
                    if let Some(to) = tx.to_account_id.as_deref() {
                        *adjustments.entry(to.to_string()).or_default() -= tx.amount;
                    }
                }
            }
        }

        if triage {
            conn.execute(
                "INSERT OR IGNORE INTO transaction_labels (transaction_id, label_id)
                 VALUES (?1, ?2)",
                params![tx.id, triage_id],
            )
            .map_err(oops)?;
            triaged += 1;
        }
    }

    let opening_adjustment = adjustments.get(account_id).copied().unwrap_or(0);
    for (acct, delta) in &adjustments {
        if *delta != 0 {
            conn.execute(
                "UPDATE accounts SET opening_balance = opening_balance + ?1 WHERE id = ?2",
                params![delta, acct],
            )
            .map_err(oops)?;
        }
    }

    guard.commit().map_err(oops)?;
    Ok(ImportResult {
        inserted,
        triaged,
        balance_neutral,
        debts,
        opening_adjustment,
    })
}

/// Pins a label on a run of postings, or takes it off them.
///
/// Answers with how many postings actually changed — a label already pinned
/// is not an edit, and saying "12 changed" when nine of them already wore it
/// would be a count of what was selected rather than of what was done.
pub fn label_transactions(
    conn: &Connection,
    ids: &[String],
    label_id: &str,
    on: bool,
) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let holes = vec!["?"; ids.len()].join(",");
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&label_id];
    for id in ids {
        args.push(id);
    }
    let changed = if on {
        conn.execute(
            &format!(
                "INSERT OR IGNORE INTO transaction_labels (transaction_id, label_id)
                 SELECT t.id, ?1 FROM transactions t WHERE t.id IN ({holes})"
            ),
            params_from_iter(args),
        )
    } else {
        conn.execute(
            &format!(
                "DELETE FROM transaction_labels
                 WHERE label_id = ?1 AND transaction_id IN ({holes})"
            ),
            params_from_iter(args),
        )
    }
    .map_err(oops)?;
    guard.commit().map_err(oops)?;
    Ok(changed as i64)
}

/// A person has looked at these postings and said they are filed right. The
/// Triage label comes off, and how each one is filed is written down against
/// its counterparty — which is what makes the next import of them arrive
/// already classified.
pub fn confirm_triage(conn: &Connection, ids: &[String]) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let triage_id = conn
        .query_row(
            "SELECT id FROM labels WHERE name = ?1",
            params![TRIAGE_LABEL],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(oops)?;

    let mut confirmed = 0i64;
    for id in ids {
        let found = conn
            .query_row(
                "SELECT kind, category_id, account_id, to_account_id, merchant, note,
                        import_key
                 FROM transactions WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(oops)?;
        let Some((kind, category_id, from_account, to_account, merchant, note, import_key)) =
            found
        else {
            continue;
        };

        // The key the importer recognised this row by, stamped at import
        // time; rows from before that column existed fall back to reading
        // the narration out of the note.
        let key = import_key.or_else(|| note.as_deref().and_then(crate::import::match_key));
        if let Some(key) = key {
            let is_transfer = kind == "transfer";
            remember_rule(
                conn,
                &key,
                &kind,
                category_id.as_deref(),
                Some(from_account.as_str()).filter(|_| is_transfer),
                to_account.as_deref().filter(|_| is_transfer),
                &merchant,
            )?;
        }

        if let Some(triage) = triage_id.as_deref() {
            conn.execute(
                "DELETE FROM transaction_labels WHERE transaction_id = ?1 AND label_id = ?2",
                params![id, triage],
            )
            .map_err(oops)?;
        }
        confirmed += 1;
    }

    guard.commit().map_err(oops)?;
    Ok(confirmed)
}

// ------------------------------------------------------------------- debts

/// A short label for a linked posting, so the UI can name what opened a debt
/// without a second round-trip.
const TX_LABEL: &str = "
    (SELECT CASE WHEN t.merchant <> '' THEN t.merchant
                 ELSE COALESCE(c.name, 'Transaction') END
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id = ";

pub fn list_debts(conn: &Connection) -> Result<Vec<Debt>> {
    let sql = format!(
        "SELECT d.id, d.direction, d.counterparty, d.principal, d.opened_on, d.due_on,
                d.note, d.settled_at, d.created_at, d.transaction_id,
                {TX_LABEL} d.transaction_id),
                COALESCE((SELECT SUM(p.amount) FROM debt_payments p WHERE p.debt_id = d.id), 0),
                d.from_split,
                COALESCE((SELECT SUM(a.amount) FROM debt_additions a WHERE a.debt_id = d.id), 0)
         FROM debts d
         ORDER BY d.settled_at IS NOT NULL, d.opened_on DESC, d.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let mut debts = stmt
        .query_map([], |r| {
            let opening: Paise = r.get(3)?;
            let paid: Paise = r.get(11)?;
            let added: Paise = r.get(13)?;
            let settled_at: Option<String> = r.get(7)?;
            let principal = opening + added;
            let outstanding = (principal - paid).max(0);
            Ok(Debt {
                id: r.get(0)?,
                direction: r.get(1)?,
                counterparty: r.get(2)?,
                principal,
                opening,
                opened_on: r.get(4)?,
                due_on: r.get(5)?,
                note: r.get(6)?,
                settled: settled_at.is_some() || outstanding == 0,
                settled_at,
                created_at: r.get(8)?,
                transaction_id: r.get(9)?,
                transaction_label: r.get(10)?,
                from_split: r.get::<_, i64>(12)? != 0,
                paid,
                added,
                outstanding,
                payments: Vec::new(),
                additions: Vec::new(),
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    for payment in debt_movements(conn, Movement::Repayment)? {
        if let Some(debt) = debts.iter_mut().find(|d| d.id == payment.debt_id) {
            debt.payments.push(payment);
        }
    }
    for addition in debt_movements(conn, Movement::Addition)? {
        if let Some(debt) = debts.iter_mut().find(|d| d.id == addition.debt_id) {
            debt.additions.push(addition);
        }
    }
    Ok(debts)
}

/// Money that moved against a debt after it opened: some of it coming back,
/// or more of it handed over. The two are kept apart, in tables of their own,
/// so that nothing summing one can ever count the other by mistake — but they
/// are the same shape and are written the same way, differing only in which
/// way the money went.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Movement {
    Repayment,
    Addition,
}

impl Movement {
    fn table(self) -> &'static str {
        match self {
            Movement::Repayment => "debt_payments",
            Movement::Addition => "debt_additions",
        }
    }
}

/// Every repayment, or every addition, across the book, newest first.
fn debt_movements(conn: &Connection, movement: Movement) -> Result<Vec<DebtPayment>> {
    let sql = format!(
        "SELECT p.id, p.debt_id, p.amount, p.occurred_at, p.note, p.transaction_id,
                {TX_LABEL} p.transaction_id), p.created_at,
                -- Which end of its own transfer is the money's: the side that
                -- is not the account standing for what is out with people.
                CASE WHEN p.owns_transaction = 1 THEN (
                    SELECT CASE WHEN fa.name = '{DEBT}' THEN t.to_account_id
                                ELSE t.account_id END
                    FROM transactions t JOIN accounts fa ON fa.id = t.account_id
                    WHERE t.id = p.transaction_id) END,
                {spread}
         FROM {table} p ORDER BY p.occurred_at DESC",
        DEBT = DEBT_ACCOUNT,
        table = movement.table(),
        // Only a repayment is ever spread; what is added goes on one debt.
        spread = match movement {
            Movement::Repayment => "p.spread_id",
            Movement::Addition => "NULL",
        },
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DebtPayment {
                id: r.get(0)?,
                debt_id: r.get(1)?,
                amount: r.get(2)?,
                occurred_at: r.get(3)?,
                note: r.get(4)?,
                transaction_id: r.get(5)?,
                transaction_label: r.get(6)?,
                created_at: r.get(7)?,
                cash_account_id: r.get(8)?,
                spread_id: r.get(9)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

pub fn save_debt(conn: &Connection, input: DebtInput) -> Result<()> {
    if input.principal <= 0 {
        return Err("A debt needs an amount greater than zero.".into());
    }
    if input.counterparty.trim().is_empty() {
        return Err("Who is this debt with?".into());
    }
    match input.id {
        Some(id) => {
            // Preserve when it was settled unless the flag itself changed.
            let previous: Option<String> = conn
                .query_row("SELECT settled_at FROM debts WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(oops)?
                .flatten();
            let settled_at = match input.settled {
                Some(true) => previous.clone().or_else(|| Some(now())),
                Some(false) => None,
                None => previous,
            };
            conn.execute(
                "UPDATE debts SET direction = ?2, counterparty = ?3, principal = ?4,
                        opened_on = ?5, due_on = ?6, note = ?7, transaction_id = ?8,
                        settled_at = ?9
                 WHERE id = ?1",
                params![
                    id,
                    input.direction,
                    input.counterparty.trim(),
                    input.principal,
                    input.opened_on,
                    input.due_on,
                    input.note,
                    input.transaction_id,
                    settled_at
                ],
            )
            .map_err(oops)?;
        }
        None => {
            conn.execute(
                "INSERT INTO debts (id, direction, counterparty, principal, opened_on,
                                    due_on, note, settled_at, created_at, transaction_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    new_id(),
                    input.direction,
                    input.counterparty.trim(),
                    input.principal,
                    input.opened_on,
                    input.due_on,
                    input.note,
                    if input.settled == Some(true) { Some(now()) } else { None },
                    now(),
                    input.transaction_id
                ],
            )
            .map_err(oops)?;
        }
    }
    Ok(())
}

/// Everything the ledger holds for one debt: the posting that opened it, the
/// postings that added to it and repaid it, and whatever else was filed
/// against it. Ordered
/// as the ledger is, newest first.
pub fn debt_entries(conn: &Connection, debt_id: &str) -> Result<Vec<Transaction>> {
    let mut stmt = conn
        .prepare(
            "SELECT transaction_id FROM debt_entries WHERE debt_id = ?1
             UNION
             SELECT transaction_id FROM debts
              WHERE id = ?1 AND transaction_id IS NOT NULL
             UNION
             SELECT transaction_id FROM debt_payments
              WHERE debt_id = ?1 AND transaction_id IS NOT NULL
             UNION
             SELECT transaction_id FROM debt_additions
              WHERE debt_id = ?1 AND transaction_id IS NOT NULL",
        )
        .map_err(oops)?;
    let ids = stmt
        .query_map(params![debt_id], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);

    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        if let Ok(tx) = get_transaction(conn, &id) {
            rows.push(tx);
        }
    }
    rows.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at));
    Ok(rows)
}

pub fn delete_debt(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM debts WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

/// Which way the debt standing against a posting runs, if one does at all.
/// What the save is carrying comes first; failing that, what the book already
/// holds against the posting being edited.
fn debt_side(conn: &Connection, input: &TransactionInput) -> Result<Option<String>> {
    if let Some(shares) = input.shares.as_deref() {
        return Ok(shares.first().map(|s| s.direction.clone()));
    }
    let Some(id) = input.id.as_deref() else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT direction FROM debts WHERE transaction_id = ?1 AND from_split = 1 LIMIT 1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(oops)
}

/// The account money out with people sits in: archived, so it never counts
/// toward net worth — what is owed is counted by the debt itself, and
/// counting the account as well would count it twice. A transfer against it
/// is how a hand-off reaches the ledger without reading as income or spending.
/// Which account that is, if the book has one yet. Held by id in the settings
/// rather than found by name: it is the book's own account, and a name is a
/// thing that gets changed — by this very migration, once.
pub fn debt_account_id(conn: &Connection) -> Result<Option<String>> {
    let held: Option<String> = setting(conn, DEBT_ACCOUNT_KEY)?;
    if let Some(id) = held {
        let alive: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM accounts WHERE id = ?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(oops)?
            > 0;
        if alive {
            return Ok(Some(id));
        }
    }
    // A book from before the setting existed: the account is there under one
    // of the two names it has had.
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM accounts WHERE name IN (?1, ?2) ORDER BY name = ?1 DESC LIMIT 1",
            params![DEBT_ACCOUNT, DEBT_ACCOUNT_WAS],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(oops)?;
    if let Some(id) = found.as_deref() {
        conn.execute(
            "UPDATE accounts SET name = ?2 WHERE id = ?1",
            params![id, DEBT_ACCOUNT],
        )
        .map_err(oops)?;
        set_setting(conn, DEBT_ACCOUNT_KEY, id)?;
    }
    Ok(found)
}

fn debt_account(conn: &Connection) -> Result<String> {
    if let Some(id) = debt_account_id(conn)? {
        return Ok(id);
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO accounts (id, name, kind, institution, opening_balance, color, icon,
                               archived, sort_order, created_at, credit_limit)
         VALUES (?1, ?2, 'cash', NULL, 0, '#979DB5', 'users', 1, 900, ?3, 0)",
        params![id, DEBT_ACCOUNT, now()],
    )
    .map_err(oops)?;
    set_setting(conn, DEBT_ACCOUNT_KEY, &id)?;
    Ok(id)
}

pub const DEBT_ACCOUNT: &str = "Debts";
/// What it was called before, in books that have one already.
const DEBT_ACCOUNT_WAS: &str = "Lent & borrowed";
const DEBT_ACCOUNT_KEY: &str = "debt_account";

pub fn save_debt_payment(conn: &Connection, input: DebtPaymentInput) -> Result<()> {
    save_debt_movement(conn, Movement::Repayment, input)
}

/// More handed over against a debt already open. Written exactly as a
/// repayment is, with the money going the other way: out to them again when
/// you lent, in from them again when you borrowed.
pub fn save_debt_addition(conn: &Connection, input: DebtAdditionInput) -> Result<()> {
    save_debt_movement(conn, Movement::Addition, input)
}

fn save_debt_movement(conn: &Connection, movement: Movement, input: DebtPaymentInput) -> Result<()> {
    if input.amount <= 0 {
        return Err(match movement {
            Movement::Repayment => "A repayment needs an amount greater than zero.",
            Movement::Addition => "Adding to a debt needs an amount greater than zero.",
        }
        .into());
    }
    let table = movement.table();
    let guard = conn.unchecked_transaction().map_err(oops)?;

    // A piece of a spread repayment is one part of a single repayment, and
    // changing it alone would leave the rest, and the posting, saying
    // something else.
    if movement == Movement::Repayment {
        if let Some(id) = input.id.as_deref() {
            let spread: Option<String> = conn
                .query_row(
                    "SELECT spread_id FROM debt_payments WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(oops)?
                .flatten();
            if spread.is_some() {
                return Err(
                    "This repayment was spread across several debts — change it from the person's page.".into(),
                );
            }
        }
    }

    // What this entry already names, and whether it wrote it.
    let (had_tx, had_own): (Option<String>, bool) = match input.id.as_deref() {
        Some(id) => conn
            .query_row(
                &format!("SELECT transaction_id, owns_transaction FROM {table} WHERE id = ?1"),
                params![id],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(oops)?
            .unwrap_or((None, false)),
        None => (None, false),
    };
    let drop_owned = |conn: &Connection, tx: &Option<String>, owned: bool| -> Result<()> {
        match (owned, tx) {
            (true, Some(id)) => delete_transaction(conn, id),
            _ => Ok(()),
        }
    };

    let cash = input.cash_account_id.as_deref().filter(|a| !a.is_empty());
    let linked = input.transaction_id.as_deref().filter(|t| !t.is_empty());

    let (transaction_id, owns) = match (cash, linked) {
        // Pointing at a record already in the book: the money moved when it
        // was written down, and nothing here should move it again.
        (_, Some(tx_id)) => {
            if had_tx.as_deref() != Some(tx_id) {
                drop_owned(conn, &had_tx, had_own)?;
            }
            (Some(tx_id.to_string()), false)
        }

        // Writing the posting ourselves: money coming in lands in the chosen
        // account, money going out leaves it, and the other end is the
        // account that stands for what is out with people.
        (Some(cash_id), None) => {
            let (direction, counterparty): (String, String) = conn
                .query_row(
                    "SELECT direction, counterparty FROM debts WHERE id = ?1",
                    params![input.debt_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(oops)?
                .ok_or("That debt is no longer in your book.")?;
            // Only a posting this entry wrote may be rewritten; a linked one
            // is the user's record and is left exactly as entered.
            let reuse = if had_own { had_tx.clone() } else { None };
            let tx = write_debt_transfer(
                conn,
                movement,
                &direction,
                &counterparty,
                cash_id,
                reuse,
                input.amount,
                input.note.clone(),
                &input.occurred_at,
            )?;
            (Some(tx), true)
        }

        // Recorded without touching the ledger, for what predates it.
        (None, None) => {
            drop_owned(conn, &had_tx, had_own)?;
            (None, false)
        }
    };

    match input.id {
        Some(id) => conn.execute(
            &format!(
                "UPDATE {table} SET amount = ?2, occurred_at = ?3, note = ?4,
                        transaction_id = ?5, owns_transaction = ?6
                 WHERE id = ?1"
            ),
            params![
                id,
                input.amount,
                input.occurred_at,
                input.note,
                transaction_id,
                owns as i64
            ],
        ),
        None => conn.execute(
            &format!(
                "INSERT INTO {table} (id, debt_id, amount, occurred_at, note,
                                      transaction_id, owns_transaction, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
            ),
            params![
                new_id(),
                input.debt_id,
                input.amount,
                input.occurred_at,
                input.note,
                transaction_id,
                owns as i64,
                now()
            ],
        ),
    }
    .map_err(oops)?;
    guard.commit().map_err(oops)?;
    Ok(())
}

/// Writes the transfer a debt entry stands for: out of the chosen account
/// when you are lending more or paying back what you borrowed, into it when
/// they are paying you back or lending you more. The other end is the account
/// that stands for what is out with people.
#[allow(clippy::too_many_arguments)]
fn write_debt_transfer(
    conn: &Connection,
    movement: Movement,
    direction: &str,
    counterparty: &str,
    cash_id: &str,
    reuse: Option<String>,
    amount: Paise,
    note: Option<String>,
    occurred_at: &str,
) -> Result<String> {
    let holding = debt_account(conn)?;
    if cash_id == holding {
        return Err(format!(
            "Pick the account the money actually moved through — {DEBT_ACCOUNT} is the other side of it."
        ));
    }
    let leaving = (direction == "lent") == (movement == Movement::Addition);
    let (from, to) = if leaving {
        (cash_id.to_string(), holding)
    } else {
        (holding, cash_id.to_string())
    };
    let tx = save_transaction(
        conn,
        TransactionInput {
            id: reuse,
            kind: "transfer".into(),
            amount,
            account_id: from,
            to_account_id: Some(to),
            category_id: None,
            merchant: counterparty.to_string(),
            note,
            occurred_at: format!("{}T12:00", &occurred_at[..10.min(occurred_at.len())]),
            splits: None,
            shares: None,
            label_ids: None,
            refund_of: None,
            cashback: None,
        },
    )?;
    Ok(tx.id)
}

/// Whose debt this is, the way the Debts screen groups them: the same name,
/// whatever its spacing or case, is the same person.
fn person_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// One repayment from somebody you have several debts open with. It is laid
/// over them oldest first — each bill is cleared before the next one is
/// touched — and anything beyond what they owe goes on the newest, the way
/// paying one debt too much is recorded. One posting stands behind all of it.
///
/// Changing one takes its old pieces off first and lays it out again, so a
/// debt it had cleared is open to it once more.
pub fn save_person_repayment(conn: &Connection, input: PersonRepaymentInput) -> Result<String> {
    if input.amount <= 0 {
        return Err("A repayment needs an amount greater than zero.".into());
    }
    if input.direction != "lent" && input.direction != "borrowed" {
        return Err("A debt is either lent or borrowed.".into());
    }
    let guard = conn.unchecked_transaction().map_err(oops)?;

    // What the repayment wrote before, if it is being changed.
    let (had_tx, had_own): (Option<String>, bool) = match input.spread_id.as_deref() {
        Some(spread) => {
            let row: Option<(Option<String>, bool)> = conn
                .query_row(
                    "SELECT transaction_id, MAX(owns_transaction) FROM debt_payments
                     WHERE spread_id = ?1 GROUP BY spread_id",
                    params![spread],
                    |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
                )
                .optional()
                .map_err(oops)?;
            conn.execute("DELETE FROM debt_payments WHERE spread_id = ?1", params![spread])
                .map_err(oops)?;
            row.unwrap_or((None, false))
        }
        None => (None, false),
    };

    // The debts it can go against, oldest first, with what is left on each.
    let who = person_key(&input.counterparty);
    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.counterparty,
                    d.principal
                      + COALESCE((SELECT SUM(a.amount) FROM debt_additions a WHERE a.debt_id = d.id), 0)
                      - COALESCE((SELECT SUM(p.amount) FROM debt_payments p WHERE p.debt_id = d.id), 0)
             FROM debts d
             WHERE d.direction = ?1 AND d.settled_at IS NULL
             ORDER BY d.opened_on, d.created_at",
        )
        .map_err(oops)?;
    let open: Vec<(String, String, Paise)> = stmt
        .query_map(params![input.direction], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Paise>(2)?))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?
        .into_iter()
        .filter(|(_, name, left)| *left > 0 && person_key(name) == who)
        .collect();
    drop(stmt);
    let Some((_, name, _)) = open.last() else {
        return Err(format!("Nothing is owed with {} to repay.", input.counterparty.trim()));
    };
    let name = name.clone();

    let mut pieces: Vec<(String, Paise)> = Vec::new();
    let mut left = input.amount;
    for (id, _, owed) in &open {
        if left == 0 {
            break;
        }
        let take = left.min(*owed);
        pieces.push((id.clone(), take));
        left -= take;
    }
    if left > 0 {
        // Every debt is cleared and there is still money: it is more than
        // was owed, and it sits on the newest.
        if let Some(last) = pieces.last_mut() {
            last.1 += left;
        }
    }

    let cash = input.cash_account_id.as_deref().filter(|a| !a.is_empty());
    let linked = input.transaction_id.as_deref().filter(|t| !t.is_empty());
    let drop_owned = |conn: &Connection| -> Result<()> {
        match (had_own, &had_tx) {
            (true, Some(id)) => delete_transaction(conn, id),
            _ => Ok(()),
        }
    };
    let (transaction_id, owns) = match (cash, linked) {
        (_, Some(tx_id)) => {
            if had_tx.as_deref() != Some(tx_id) {
                drop_owned(conn)?;
            }
            (Some(tx_id.to_string()), false)
        }
        (Some(cash_id), None) => {
            let reuse = if had_own { had_tx.clone() } else { None };
            let tx = write_debt_transfer(
                conn,
                Movement::Repayment,
                &input.direction,
                &name,
                cash_id,
                reuse,
                input.amount,
                input.note.clone(),
                &input.occurred_at,
            )?;
            (Some(tx), true)
        }
        (None, None) => {
            drop_owned(conn)?;
            (None, false)
        }
    };

    let spread = input.spread_id.clone().unwrap_or_else(new_id);
    for (debt_id, amount) in pieces {
        conn.execute(
            "INSERT INTO debt_payments (id, debt_id, amount, occurred_at, note,
                                        transaction_id, owns_transaction, spread_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                new_id(),
                debt_id,
                amount,
                input.occurred_at,
                input.note,
                transaction_id,
                owns as i64,
                spread,
                now()
            ],
        )
        .map_err(oops)?;
    }
    guard.commit().map_err(oops)?;
    Ok(spread)
}

/// A spread repayment goes as a whole: every piece of it, and the posting it
/// wrote. One you linked is your own record and stays.
pub fn delete_person_repayment(conn: &Connection, spread_id: &str) -> Result<()> {
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let owned: Option<String> = conn
        .query_row(
            "SELECT transaction_id FROM debt_payments
             WHERE spread_id = ?1 AND owns_transaction = 1 LIMIT 1",
            params![spread_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .flatten();
    conn.execute("DELETE FROM debt_payments WHERE spread_id = ?1", params![spread_id])
        .map_err(oops)?;
    if let Some(tx) = owned {
        delete_transaction(conn, &tx)?;
    }
    guard.commit().map_err(oops)?;
    Ok(())
}

/// The repayment goes, and the posting it wrote goes with it. One you linked
/// is your own record and stays.
pub fn delete_debt_payment(conn: &Connection, id: &str) -> Result<()> {
    delete_debt_movement(conn, Movement::Repayment, id)
}

/// The addition comes off the debt, on the same terms a repayment does.
pub fn delete_debt_addition(conn: &Connection, id: &str) -> Result<()> {
    delete_debt_movement(conn, Movement::Addition, id)
}

fn delete_debt_movement(conn: &Connection, movement: Movement, id: &str) -> Result<()> {
    let table = movement.table();
    // One piece of a spread repayment is the whole repayment.
    if movement == Movement::Repayment {
        let spread: Option<String> = conn
            .query_row(
                "SELECT spread_id FROM debt_payments WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(oops)?
            .flatten();
        if let Some(spread) = spread {
            return delete_person_repayment(conn, &spread);
        }
    }
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let owned: Option<String> = conn
        .query_row(
            &format!(
                "SELECT transaction_id FROM {table}
                 WHERE id = ?1 AND owns_transaction = 1"
            ),
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .flatten();
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])
        .map_err(oops)?;
    if let Some(tx) = owned {
        delete_transaction(conn, &tx)?;
    }
    guard.commit().map_err(oops)?;
    Ok(())
}

/// Outstanding totals across open debts, as (owed to you, owed by you).
fn debt_positions(conn: &Connection) -> Result<(Paise, Paise)> {
    let mut stmt = conn
        .prepare(
            "SELECT d.direction,
                    COALESCE(SUM(MAX(0, d.principal
                      + COALESCE((SELECT SUM(a.amount) FROM debt_additions a
                                  WHERE a.debt_id = d.id), 0)
                      - COALESCE((SELECT SUM(p.amount) FROM debt_payments p
                                  WHERE p.debt_id = d.id), 0))), 0)
             FROM debts d WHERE d.settled_at IS NULL GROUP BY d.direction",
        )
        .map_err(oops)?;
    let mut lent = 0;
    let mut borrowed = 0;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Paise>(1)?)))
        .map_err(oops)?;
    for row in rows {
        let (direction, total) = row.map_err(oops)?;
        if direction == "lent" {
            lent = total;
        } else {
            borrowed = total;
        }
    }
    Ok((lent, borrowed))
}

// ------------------------------------------------------------- investments

/// Cached prices are keyed by instrument: spot gold and the rupee are shared
/// by every gold holding, while each fund carries its own scheme's NAV.
pub const KEY_GOLD: &str = "gold.usd_oz";
pub const KEY_FX: &str = "fx.usdinr";

/// The landed-cost multiplier over international spot gold, scaled by 10^4.
/// Indian physical gold carries import duty and GST on top of the world price
/// — about 9% between them — and those rates move with the budget, so this is
/// a setting rather than a constant compiled into the app.
pub const GOLD_LANDED_KEY: &str = "gold_landed_e4";
const GOLD_LANDED_DEFAULT: i64 = 10_900;

pub fn gold_landed_e4(conn: &Connection) -> Result<i64> {
    Ok(setting(conn, GOLD_LANDED_KEY)?
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(GOLD_LANDED_DEFAULT))
}

/// Divide rounding half away from zero, so the two sides of a sale round by
/// the same distance rather than drifting towards it.
fn div_round(num: i128, den: i128) -> i128 {
    if num >= 0 {
        (num + den / 2) / den
    } else {
        (num - den / 2) / den
    }
}

/// `quantity_e4 × price_e4 / 10^6`, in whole paise: each input carries a 10^4
/// scale and paise adds another 10^2. Quantities are summed exactly across
/// every lot first, so this rounds once per holding rather than once per buy.
fn market_value_paise(qty_e4: Scaled, price_e4: Scaled) -> Paise {
    div_round(qty_e4 as i128 * price_e4 as i128, 1_000_000) as Paise
}

/// Spot dollars an ounce folded with the rupee, the landed-cost multiplier and
/// the metal's purity, into rupees a gram. The numerator reaches ~10^21, which
/// is why this works in i128 — i64 overflows it a few hundred times over.
pub fn gold_price_e4(usd_oz_e4: i64, inr_usd_e4: i64, landed_e4: i64, purity_e4: i64) -> Scaled {
    /// Grams in a troy ounce, scaled by 10^4.
    const TROY_OUNCE_G_E4: i128 = 311_035;
    let num =
        usd_oz_e4 as i128 * inr_usd_e4 as i128 * landed_e4 as i128 * purity_e4 as i128;
    div_round(num, 10_000 * 10_000 * TROY_OUNCE_G_E4) as Scaled
}

/// Everything the price cache holds, read once so that valuing a page of
/// holdings doesn't hit the database per row.
struct PriceBook {
    rows: HashMap<String, (Scaled, String)>,
    landed_e4: i64,
}

impl PriceBook {
    fn load(conn: &Connection) -> Result<Self> {
        let mut stmt = conn
            .prepare("SELECT key, price_e4, as_of FROM price_cache")
            .map_err(oops)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, Scaled>(1)?, r.get::<_, String>(2)?),
                ))
            })
            .map_err(oops)?
            .collect::<rusqlite::Result<HashMap<_, _>>>()
            .map_err(oops)?;
        Ok(Self {
            rows,
            landed_e4: gold_landed_e4(conn)?,
        })
    }

    /// Rupees per gram or per unit for one holding, with the date that price
    /// is good for. `None` when nothing has been fetched for it yet — every
    /// caller then leaves the holding out rather than valuing it at nothing.
    fn price_for(
        &self,
        kind: &str,
        scheme_code: Option<&str>,
        purity_e4: Option<Scaled>,
    ) -> Option<(Scaled, String)> {
        if kind == "gold" {
            let (usd_oz, as_of) = self.rows.get(KEY_GOLD)?;
            let (inr_usd, _) = self.rows.get(KEY_FX)?;
            let purity = purity_e4.unwrap_or(10_000);
            Some((
                gold_price_e4(*usd_oz, *inr_usd, self.landed_e4, purity),
                as_of.clone(),
            ))
        } else {
            let (nav, as_of) = self.rows.get(&format!("mf:{}", scheme_code?))?;
            Some((*nav, as_of.clone()))
        }
    }
}

/// A scaled quantity written out plainly, for error messages.
fn fmt_qty(q_e4: Scaled) -> String {
    let whole = q_e4 / 10_000;
    let frac = (q_e4 % 10_000).abs();
    let s = format!("{whole}.{frac:04}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn account_kind(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row("SELECT kind FROM accounts WHERE id = ?1", params![id], |r| {
        r.get(0)
    })
    .optional()
    .map_err(oops)?
    .ok_or_else(|| "That account no longer exists.".to_string())
}

/// Grams or units on hand, optionally ignoring one lot — the one being edited,
/// whose old quantity must not be counted against its new one.
fn units_held(conn: &Connection, holding_id: &str, except: Option<&str>) -> Result<Scaled> {
    conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN kind = 'buy' THEN quantity_e4
                                  ELSE -quantity_e4 END), 0)
         FROM investment_lots
         WHERE holding_id = ?1 AND (?2 IS NULL OR id <> ?2)",
        params![holding_id, except],
        |r| r.get(0),
    )
    .map_err(oops)
}

/// What a deposit is worth on a given day.
///
/// Indian deposits compound quarterly, and a recurring one is simply a
/// series of deposits that each start earning on the day it is paid — so
/// both kinds are the same sum, over one instalment or over many. Nothing
/// earns past maturity: after that day it is a fixed amount waiting to be
/// collected, not a balance still growing.
fn deposit_value(rate_e4: Option<Scaled>, matures_on: Option<&str>, on: NaiveDate,
                 instalments: &[(NaiveDate, Paise)]) -> Paise {
    let rate = rate_e4.unwrap_or(0).max(0) as f64 / 10_000.0 / 100.0;
    let until = matures_on
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .map_or(on, |m| on.min(m));
    instalments
        .iter()
        .map(|(paid_on, amount)| {
            // Rate of zero, or money not yet in, is worth exactly itself.
            let days = (until - *paid_on).num_days();
            if rate <= 0.0 || days <= 0 {
                return *amount;
            }
            let quarters = days as f64 / 365.25 * 4.0;
            (*amount as f64 * (1.0 + rate / 4.0).powf(quarters)).round() as Paise
        })
        .sum()
}

/// Every instalment a deposit is made of: what was paid, and the day it
/// started earning.
fn deposit_instalments(conn: &Connection, holding_id: &str) -> Result<Vec<(NaiveDate, Paise)>> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(l.allotted_at, l.occurred_at), l.amount
             FROM investment_lots l
             WHERE l.holding_id = ?1 AND l.kind = 'buy'",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![holding_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Paise>(1)?))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows
        .into_iter()
        .filter_map(|(day, amount)| {
            let day = NaiveDate::parse_from_str(day.get(..10)?, "%Y-%m-%d").ok()?;
            Some((day, amount))
        })
        .collect())
}

/// True for the two kinds of deposit, which are valued by what they have
/// earned rather than by what a market says they would fetch.
fn is_deposit(kind: &str) -> bool {
    kind == "fd" || kind == "rd"
}

pub fn list_holdings(conn: &Connection) -> Result<Vec<Holding>> {
    let book = PriceBook::load(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.kind, h.name, h.account_id, a.name, h.scheme_code, h.isin,
                    h.purity_e4, h.note, h.closed_at, h.created_at, h.acquired_on,
                    CASE WHEN h.kind = 'gold' THEN h.grams_e4 ELSE
                      COALESCE((SELECT SUM(CASE WHEN l.kind = 'buy' THEN l.quantity_e4
                                                ELSE -l.quantity_e4 END)
                                FROM investment_lots l WHERE l.holding_id = h.id), 0) END,
                    COALESCE((SELECT SUM(l.amount) FROM investment_lots l
                              WHERE l.holding_id = h.id AND l.kind = 'buy'), 0),
                    COALESCE((SELECT SUM(l.amount) FROM investment_lots l
                              WHERE l.holding_id = h.id AND l.kind = 'sell'), 0),
                    h.rate_e4, h.opened_on, h.matures_on, h.instalment,
                    COALESCE((SELECT SUM(l.amount) FROM investment_lots l
                              WHERE l.holding_id = h.id AND l.kind = 'buy'
                                AND l.quantity_e4 = 0), 0)
             FROM holdings h
             LEFT JOIN accounts a ON a.id = h.account_id
             ORDER BY h.closed_at IS NOT NULL, h.kind, h.created_at DESC",
        )
        .map_err(oops)?;
    let mut holdings = stmt
        .query_map([], |r| {
            let kind: String = r.get(1)?;
            // Gold reports no return — it is weighed, not bought and sold —
            // and a deposit's return is filled in with its value below.
            let is_gold = kind == "gold" || is_deposit(&kind);
            let scheme_code: Option<String> = r.get(5)?;
            let purity_e4: Option<Scaled> = r.get(7)?;
            let closed_at: Option<String> = r.get(9)?;
            let units_e4: Scaled = r.get(12)?;
            let invested: Paise = r.get(13)?;
            let realised: Paise = r.get(14)?;
            let rate_e4: Option<Scaled> = r.get(15)?;
            let opened_on: Option<String> = r.get(16)?;
            let matures_on: Option<String> = r.get(17)?;
            let priced = book.price_for(&kind, scheme_code.as_deref(), purity_e4);
            // Money in, units not landed yet. It is worth what was paid until
            // the AMC says otherwise — anything else would have a week's
            // savings disappear from your net worth between the debit and the
            // allotment, which is the one thing that certainly did not happen.
            let pending: Paise = r.get(19)?;
            // A deposit has no price to look up: it is worth what it has
            // earned, which is filled in below where the connection is at
            // hand to read its instalments.
            let market_value = priced
                .as_ref()
                .map(|(price, _)| market_value_paise(units_e4.max(0), *price) + pending)
                .unwrap_or(0);
            Ok(Holding {
                id: r.get(0)?,
                kind,
                name: r.get(2)?,
                account_id: r.get(3)?,
                account_name: r.get(4)?,
                scheme_code,
                isin: r.get(6)?,
                purity_e4,
                note: r.get(8)?,
                closed: closed_at.is_some(),
                closed_at,
                created_at: r.get(10)?,
                acquired_on: r.get(11)?,
                units_e4,
                invested,
                realised,
                price_e4: priced.as_ref().map(|(price, _)| *price),
                price_as_of: priced.map(|(_, as_of)| as_of),
                market_value,
                // What the position has made overall: what it is worth now,
                // plus what selling already returned, less what it all cost.
                // Gold has none of that behind it — it is weighed, not bought
                // and sold — so it reports no return rather than a fake one.
                total_return: if is_gold { 0 } else { market_value + realised - invested },
                rate_e4,
                opened_on,
                matures_on,
                maturity_value: 0,
                instalment: r.get(18)?,
                pending,
                lots: Vec::new(),
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    // What each deposit has earned, and what it will be worth when it comes
    // back. Both are computed rather than priced.
    let today = Utc::now().date_naive();
    for holding in holdings.iter_mut().filter(|h| is_deposit(&h.kind)) {
        let paid = deposit_instalments(conn, &holding.id)?;
        holding.market_value = deposit_value(
            holding.rate_e4,
            holding.matures_on.as_deref(),
            today,
            &paid,
        );
        holding.maturity_value = match holding
            .matures_on
            .as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        {
            Some(day) => deposit_value(holding.rate_e4, holding.matures_on.as_deref(), day, &paid),
            // Nothing says when it ends, so there is no maturity figure to
            // quote — only what it is worth today.
            None => 0,
        };
        holding.total_return = holding.market_value + holding.realised - holding.invested;
    }

    let sql = format!(
        "SELECT l.id, l.holding_id, l.kind, l.quantity_e4, l.amount, l.occurred_at,
                l.allotted_at, l.transaction_id, {TX_LABEL} l.transaction_id),
                CASE WHEN t.account_id = h.account_id THEN t.to_account_id
                     ELSE t.account_id END,
                l.owns_transaction, l.note, l.created_at
         FROM investment_lots l
         JOIN holdings h ON h.id = l.holding_id
         LEFT JOIN transactions t ON t.id = l.transaction_id
         ORDER BY COALESCE(l.allotted_at, l.occurred_at) DESC, l.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let lots = stmt
        .query_map([], |r| {
            Ok(InvestmentLot {
                id: r.get(0)?,
                holding_id: r.get(1)?,
                kind: r.get(2)?,
                quantity_e4: r.get(3)?,
                amount: r.get(4)?,
                occurred_at: r.get(5)?,
                allotted_at: r.get(6)?,
                transaction_id: r.get(7)?,
                transaction_label: r.get(8)?,
                cash_account_id: r.get(9)?,
                owns_transaction: r.get::<_, i64>(10)? != 0,
                note: r.get(11)?,
                created_at: r.get(12)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    for lot in lots {
        if let Some(holding) = holdings.iter_mut().find(|h| h.id == lot.holding_id) {
            holding.lots.push(lot);
        }
    }
    Ok(holdings)
}

pub fn save_holding(conn: &Connection, input: HoldingInput) -> Result<()> {
    if input.name.trim().is_empty() {
        return Err("Give the holding a name.".into());
    }
    if !matches!(input.kind.as_str(), "gold" | "fund" | "fd" | "rd") {
        return Err("A holding is gold, a fund, or a deposit.".into());
    }

    // A deposit is defined by its terms rather than by units: what it pays,
    // when it started, and when it comes back.
    let deposit = is_deposit(&input.kind);
    let (rate_e4, opened_on, matures_on) = if deposit {
        let rate = input.rate_e4.unwrap_or(0);
        if rate < 0 || rate > 1_000_000 {
            return Err("That interest rate isn't a rate.".into());
        }
        let day = |d: Option<String>, what: &str| -> Result<Option<String>> {
            match d.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
                None => Ok(None),
                Some(day) => {
                    if NaiveDate::parse_from_str(&day, "%Y-%m-%d").is_err() {
                        return Err(format!("That {what} date isn't a date."));
                    }
                    Ok(Some(day))
                }
            }
        };
        let opened = day(input.opened_on, "opening")?;
        let matures = day(input.matures_on, "maturity")?;
        if let (Some(o), Some(m)) = (&opened, &matures) {
            if m < o {
                return Err("A deposit can't mature before it was opened.".into());
            }
        }
        (Some(rate), opened, matures)
    } else {
        (None, None, None)
    };

    // What a recurring deposit puts in each month. Only an RD has one; a
    // fixed deposit is paid once, at the start.
    let instalment = if input.kind == "rd" {
        let amount = input.instalment.unwrap_or(0);
        if amount < 0 {
            return Err("An instalment can't be less than nothing.".into());
        }
        amount
    } else {
        0
    };

    // Each kind carries only its own fields, so changing a holding's kind can
    // never leave a scheme code on a gold bar. Account credit limits are kept
    // tidy the same way.
    let (scheme_code, isin, purity_e4, grams_e4) = if deposit {
        (None, None, None, 0)
    } else if input.kind == "fund" {
        let code = input
            .scheme_code
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .ok_or("Pick the fund's scheme, so its NAV can be fetched.")?;
        (Some(code), input.isin, None, 0)
    } else {
        let purity = input.purity_e4.unwrap_or(10_000);
        if purity <= 0 || purity > 10_000 {
            return Err("Purity runs from 1 up to 24 carat.".into());
        }
        // Weight is the whole of a gold holding. Without it there is nothing
        // to value, so it is asked for rather than defaulted to nothing.
        let grams = input.grams_e4.unwrap_or(0);
        if grams <= 0 {
            return Err("How many grams? Gold is tracked by weight.".into());
        }
        (None, None, Some(purity), grams)
    };

    // A fund is dated by its lots; only gold carries a day of its own, and a
    // day it hasn't reached yet would draw a chart of metal you don't have.
    let acquired_on = input
        .acquired_on
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty() && input.kind == "gold");
    if let Some(day) = &acquired_on {
        if NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err() {
            return Err("That acquisition date isn't a date.".into());
        }
        if *day > Utc::now().date_naive().format("%Y-%m-%d").to_string() {
            return Err("Gold can't have been acquired in the future.".into());
        }
    }

    // Gold sits in a locker, not in an account: nothing posts on its behalf,
    // so there is no investment account for it to move money through.
    let account_id = input
        .account_id
        .filter(|a| !a.is_empty() && (input.kind == "fund" || deposit));
    if let Some(id) = &account_id {
        if account_kind(conn, id)? != "investment" {
            return Err("Purchases post into an investment account — pick one of those.".into());
        }
    }

    // The id either way, so what the holding keeps beside it — the plan an RD
    // falls due on — can be hung off it whether it was written now or before.
    let holding_id = input.id.clone().unwrap_or_else(new_id);

    match input.id.clone() {
        Some(id) => {
            // A fund's entries have nowhere to go once it becomes gold, and
            // silently dropping them would take their postings' basis with
            // them. Say so instead of losing the history.
            if input.kind == "gold" {
                let entries: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM investment_lots WHERE holding_id = ?1",
                        params![id],
                        |r| r.get(0),
                    )
                    .map_err(oops)?;
                if entries > 0 {
                    return Err(
                        "This holding has purchases recorded against it. Delete those first, or keep it a fund."
                            .into(),
                    );
                }
            }
            // Preserve when it was closed unless the flag itself changed.
            let previous: Option<String> = conn
                .query_row(
                    "SELECT closed_at FROM holdings WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(oops)?
                .flatten();
            let closed_at = match input.closed {
                Some(true) => previous.clone().or_else(|| Some(now())),
                Some(false) => None,
                None => previous,
            };
            conn.execute(
                "UPDATE holdings SET kind = ?2, name = ?3, account_id = ?4, scheme_code = ?5,
                        isin = ?6, purity_e4 = ?7, grams_e4 = ?8, note = ?9, closed_at = ?10,
                        acquired_on = ?11, rate_e4 = ?12, opened_on = ?13, matures_on = ?14,
                        instalment = ?15
                 WHERE id = ?1",
                params![
                    id,
                    input.kind,
                    input.name.trim(),
                    account_id,
                    scheme_code,
                    isin,
                    purity_e4,
                    grams_e4,
                    input.note,
                    closed_at,
                    acquired_on,
                    rate_e4,
                    opened_on,
                    matures_on,
                    instalment
                ],
            )
        }
        None => conn.execute(
            "INSERT INTO holdings (id, kind, name, account_id, scheme_code, isin,
                                   purity_e4, grams_e4, note, closed_at, created_at,
                                   acquired_on, rate_e4, opened_on, matures_on, instalment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                holding_id,
                input.kind,
                input.name.trim(),
                account_id,
                scheme_code,
                isin,
                purity_e4,
                grams_e4,
                input.note,
                if input.closed == Some(true) { Some(now()) } else { None },
                now(),
                acquired_on,
                rate_e4,
                opened_on,
                matures_on,
                instalment
            ],
        ),
    }
    .map_err(oops)?;
    keep_deposit_plan(
        conn,
        &input.name,
        &input.kind,
        instalment,
        opened_on.as_deref(),
        matures_on.as_deref(),
        account_id.as_deref(),
        Some(holding_id.as_str()),
    )?;
    Ok(())
}

/// The plan a recurring deposit keeps for itself.
///
/// An instalment is a standing payment like any other — it falls due, it can
/// be late, and it is paid by a posting — so it belongs on the Planned screen
/// rather than in a second place that only deposits know about. The plan is
/// the book's, not yours: it follows the deposit's own terms, and it is put
/// away when the deposit is closed or its instalment is taken off.
fn keep_deposit_plan(
    conn: &Connection,
    name: &str,
    kind: &str,
    instalment: Paise,
    opened_on: Option<&str>,
    matures_on: Option<&str>,
    account_id: Option<&str>,
    holding_id: Option<&str>,
) -> Result<()> {
    let Some(holding_id) = holding_id else {
        return Ok(());
    };
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM plans WHERE holding_id = ?1",
            params![holding_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?;

    // Nothing to fall due: not an RD any more, no instalment set, or no day
    // for it to land on. An existing plan is archived rather than deleted —
    // whatever has been paid against it is still true.
    let wanted = kind == "rd" && instalment > 0 && opened_on.is_some();
    if !wanted {
        if let Some(id) = existing {
            conn.execute("UPDATE plans SET archived = 1 WHERE id = ?1", params![id])
                .map_err(oops)?;
        }
        return Ok(());
    }
    let anchor = opened_on.unwrap_or_default();
    match existing {
        Some(id) => conn.execute(
            "UPDATE plans SET name = ?2, merchant = ?2, amount = ?3, to_account_id = ?4,
                    anchor_on = ?5, ends_on = ?6, archived = 0
             WHERE id = ?1",
            params![id, name.trim(), instalment, account_id, anchor, matures_on],
        ),
        None => conn.execute(
            "INSERT INTO plans (id, name, kind, amount, account_id, to_account_id,
                                category_id, merchant, note, cadence, every, anchor_on,
                                ends_on, archived, created_at, holding_id)
             VALUES (?1, ?2, 'transfer', ?3, NULL, ?4, NULL, ?2, ?5, 'monthly', 1, ?6,
                     ?7, 0, ?8, ?9)",
            params![
                new_id(),
                name.trim(),
                instalment,
                account_id,
                "Instalment on a recurring deposit.",
                anchor,
                matures_on,
                now(),
                holding_id
            ],
        ),
    }
    .map_err(oops)?;
    Ok(())
}

/// Drops the holding and its lots. The transfers those lots posted are real
/// entries in your book — money did leave the bank — so they stay put.
pub fn delete_holding(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM holdings WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

pub fn save_investment_lot(conn: &Connection, mut input: InvestmentLotInput) -> Result<()> {
    // A deposit is money, not units: what was paid in is the whole of it, so
    // the quantity is nominal rather than asked for.
    let into_deposit: String = conn
        .query_row(
            "SELECT kind FROM holdings WHERE id = ?1",
            params![input.holding_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .unwrap_or_default();
    if is_deposit(&into_deposit) {
        input.quantity_e4 = 10_000;
        if input.amount <= 0 {
            return Err("How much went in? A deposit is measured by its money.".into());
        }
    }
    // A purchase whose units have not landed yet. The money moved — that is
    // the fact being written down — and the units follow when the AMC says
    // so, which is what the allotment date and this quantity are for. Only a
    // buy may stand empty: there is nothing to sell that you do not hold.
    if input.quantity_e4 < 0 || (input.quantity_e4 == 0 && input.kind != "buy") {
        return Err("How much was sold? Enter a quantity above zero.".into());
    }
    if input.quantity_e4 == 0 && input.amount <= 0 {
        return Err("How much went in? A purchase is money, whether or not the units have landed.".into());
    }
    if input.amount < 0 {
        return Err("An amount cannot be negative.".into());
    }
    if input.kind != "buy" && input.kind != "sell" {
        return Err("A lot is either a buy or a sell.".into());
    }

    // The money moves on one day and the units land on another: an SIP debited
    // on the 5th is allotted at the NAV of whatever day the AMC processed it,
    // and a redemption pays out days after the units leave. The cash date is
    // what the ledger posts on; the allotment date is what the unit price
    // belongs to. Same day, which is most of them, stores nothing.
    let paid_on = day_of(&input.occurred_at, "The date the money moved")?;
    let allotted_at = match input.allotted_at.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => {
            let day = day_of(text, "The allotment date")?;
            (day != paid_on).then_some(day)
        }
        _ => None,
    };

    let (holding_name, holding_account, holding_kind) = conn
        .query_row(
            "SELECT name, account_id, kind FROM holdings WHERE id = ?1",
            params![input.holding_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(oops)?
        .ok_or("That holding no longer exists.")?;

    // Gold is weighed, not traded. There is nothing to buy or sell against
    // it — the grams on the holding are the whole record.
    if holding_kind == "gold" {
        return Err(
            "Gold is tracked by the gram — edit the holding to change how much you hold.".into(),
        );
    }

    // Selling more than is held would drive the position negative, and every
    // valuation from here on assumes it never is.
    if input.kind == "sell" {
        let held = units_held(conn, &input.holding_id, input.id.as_deref())?;
        if input.quantity_e4 > held {
            return Err(format!(
                "You hold {} of {holding_name} — that is less than the {} being sold.",
                fmt_qty(held),
                fmt_qty(input.quantity_e4)
            ));
        }
    }

    let cash = input.cash_account_id.filter(|a| !a.is_empty());
    let linked = input.transaction_id.filter(|t| !t.is_empty());
    if cash.is_some() && linked.is_some() {
        return Err(
            "A purchase either posts a new transfer or points at one you already have — not both."
                .into(),
        );
    }

    // What this lot was attached to before, and whether it wrote that itself.
    let (had_tx, had_own) = match &input.id {
        Some(id) => conn
            .query_row(
                "SELECT transaction_id, owns_transaction FROM investment_lots WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(oops)?
            .unwrap_or((None, false)),
        None => (None, false),
    };
    /// Drops the posting a lot wrote for itself. One that was linked belongs
    /// to the book, not to us, so it is only ever detached.
    fn drop_owned(conn: &Connection, tx: &Option<String>, owned: bool) -> Result<()> {
        match (owned, tx) {
            (true, Some(id)) => delete_transaction(conn, id),
            _ => Ok(()),
        }
    }

    let (transaction_id, owns) = match (&cash, &linked) {
        // Pointing at a record that is already in the book. Nothing is written
        // to the ledger — the money moved when you recorded it the first time.
        (_, Some(tx_id)) => {
            let tx = get_transaction(conn, tx_id)
                .map_err(|_| "That record is no longer in your book.".to_string())?;

            // One posting backs one lot; sharing would count its cost twice.
            let taken: Option<String> = conn
                .query_row(
                    "SELECT id FROM investment_lots
                     WHERE transaction_id = ?1 AND (?2 IS NULL OR id <> ?2)",
                    params![tx_id, input.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(oops)?;
            if taken.is_some() {
                return Err("That record is already attached to another entry.".into());
            }

            // Attaching a transfer says "this posting is the purchase", so the
            // transfer follows the holding: its investment side is repointed at
            // the holding's account. Left alone, the cash would sit in whatever
            // account it went to while the units were counted on top of it —
            // the same money twice.
            //
            // An expense needs no such fix: that money genuinely left the book,
            // so the units are new to the balance sheet on their own.
            if tx.kind == "transfer" {
                let account_id = holding_account.clone().ok_or(
                    "Give this holding an investment account first — that is where this transfer would be pointed.",
                )?;
                let cash_side = if input.kind == "buy" {
                    tx.account_id.clone()
                } else {
                    tx.to_account_id.clone().unwrap_or_default()
                };
                let already_right = if input.kind == "buy" {
                    tx.to_account_id.as_deref() == Some(account_id.as_str())
                } else {
                    tx.account_id == account_id
                };
                if !already_right {
                    if cash_side == account_id {
                        return Err(format!(
                            "That transfer already uses {} on its other side, and a transfer needs two different accounts.",
                            get_account(conn, &account_id)
                                .map(|a| a.name)
                                .unwrap_or_else(|_| "this account".into())
                        ));
                    }
                    let (from, to) = if input.kind == "buy" {
                        (cash_side, account_id)
                    } else {
                        (account_id, cash_side)
                    };
                    save_transaction(
                        conn,
                        TransactionInput {
                            id: Some(tx.id.clone()),
                            kind: "transfer".into(),
                            amount: tx.amount,
                            account_id: from,
                            to_account_id: Some(to),
                            category_id: None,
                            merchant: tx.merchant.clone(),
                            note: tx.note.clone(),
                            occurred_at: tx.occurred_at.clone(),
                            splits: None,
                            shares: None,
                            label_ids: None,
                            refund_of: None,
                            cashback: None,
                        },
                    )?;
                }
            }

            if had_tx.as_deref() != Some(tx_id.as_str()) {
                drop_owned(conn, &had_tx, had_own)?;
            }
            (Some(tx_id.clone()), false)
        }

        // Writing the transfer ourselves. Buying moves cash into the investment
        // account, selling brings it back; either way it nets to zero across the
        // book, which is the point — cash became an asset rather than was spent.
        (Some(cash_id), None) => {
            let account_id = holding_account
                .clone()
                .ok_or("Give this holding an investment account before posting purchases to it.")?;
            if *cash_id == account_id {
                return Err("Pick a different account for the money to come from.".into());
            }
            if input.amount == 0 {
                return Err(
                    "There is no money to move — leave this blank for a lot that cost nothing."
                        .into(),
                );
            }
            let (from, to) = if input.kind == "buy" {
                (cash_id.clone(), account_id)
            } else {
                (account_id, cash_id.clone())
            };
            let day = &paid_on;
            // Only a posting this lot wrote may be rewritten; a linked one is
            // the user's record and is left exactly as they entered it.
            let reuse = if had_own { had_tx.clone() } else { None };
            let tx = save_transaction(
                conn,
                TransactionInput {
                    id: reuse,
                    kind: "transfer".into(),
                    amount: input.amount,
                    account_id: from,
                    to_account_id: Some(to),
                    category_id: None,
                    merchant: holding_name,
                    note: None,
                    occurred_at: format!("{day}T12:00"),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
            )?;
            (Some(tx.id), true)
        }

        // Recorded without touching the ledger, for anything that predates it.
        (None, None) => {
            drop_owned(conn, &had_tx, had_own)?;
            (None, false)
        }
    };

    match input.id {
        Some(id) => conn.execute(
            "UPDATE investment_lots SET kind = ?2, quantity_e4 = ?3, amount = ?4,
                    occurred_at = ?5, allotted_at = ?6, transaction_id = ?7,
                    owns_transaction = ?8, note = ?9
             WHERE id = ?1",
            params![
                id,
                input.kind,
                input.quantity_e4,
                input.amount,
                input.occurred_at,
                allotted_at,
                transaction_id,
                owns as i64,
                input.note
            ],
        ),
        None => conn.execute(
            "INSERT INTO investment_lots (id, holding_id, kind, quantity_e4, amount,
                                          occurred_at, allotted_at, transaction_id,
                                          owns_transaction, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                new_id(),
                input.holding_id,
                input.kind,
                input.quantity_e4,
                input.amount,
                input.occurred_at,
                allotted_at,
                transaction_id,
                owns as i64,
                input.note,
                now()
            ],
        ),
    }
    .map_err(oops)?;
    Ok(())
}

/// A transfer this lot wrote goes with it — it only ever existed because the
/// lot did. A record you linked stays: it was in your book first.
pub fn delete_investment_lot(conn: &Connection, id: &str) -> Result<()> {
    let owned: Option<String> = conn
        .query_row(
            "SELECT transaction_id FROM investment_lots
             WHERE id = ?1 AND owns_transaction = 1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .flatten();
    conn.execute("DELETE FROM investment_lots WHERE id = ?1", params![id])
        .map_err(oops)?;
    if let Some(tx) = owned {
        delete_transaction(conn, &tx)?;
    }
    Ok(())
}

/// What needs fetching: whether any gold is held at all, and every distinct
/// scheme code across the funds. Closed positions are included — they can be
/// reopened, and a stale price on one reads worse than a wasted request.
pub fn price_keys_needed(conn: &Connection) -> Result<(bool, Vec<String>)> {
    let gold: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM holdings WHERE kind = 'gold'",
            [],
            |r| r.get(0),
        )
        .map_err(oops)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT scheme_code FROM holdings
             WHERE kind = 'fund' AND scheme_code IS NOT NULL AND scheme_code <> ''",
        )
        .map_err(oops)?;
    let schemes = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok((gold > 0, schemes))
}

pub fn store_prices(conn: &Connection, quotes: &[Quote]) -> Result<()> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO price_cache (key, price_e4, as_of, fetched_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET price_e4 = excluded.price_e4,
                    as_of = excluded.as_of, fetched_at = excluded.fetched_at,
                    source = excluded.source",
        )
        .map_err(oops)?;
    let fetched_at = now();
    for q in quotes {
        stmt.execute(params![q.key, q.price_e4, q.as_of, fetched_at, q.source])
            .map_err(oops)?;
    }
    drop(stmt);
    // Today's quote is also tomorrow's history. Refreshing on a day already
    // recorded overwrites it rather than piling a second row on the date.
    //
    // Gold is the exception: its line is London's daily fix, and the live spot
    // quote this app values holdings at comes off another feed that runs a
    // couple of percent apart from it. Filing one under the other would put a
    // step in the line at the seam that no market ever made — so gold's
    // history only ever comes from the fix, and today's spot is left to do
    // what it is for, which is saying what the metal is worth right now.
    for q in quotes.iter().filter(|q| q.key != KEY_GOLD) {
        store_history(conn, &q.key, &[(q.as_of.clone(), q.price_e4)])?;
    }
    Ok(())
}

/// Files a run of daily prices under one instrument. Dates already on file are
/// overwritten, so a backfill can be run twice without doubling anything up.
pub fn store_history(conn: &Connection, key: &str, points: &[(String, Scaled)]) -> Result<()> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO price_history (key, as_of, price_e4) VALUES (?1, ?2, ?3)
             ON CONFLICT(key, as_of) DO UPDATE SET price_e4 = excluded.price_e4",
        )
        .map_err(oops)?;
    for (as_of, price_e4) in points {
        stmt.execute(params![key, as_of, price_e4]).map_err(oops)?;
    }
    Ok(())
}

/// The first and last day one instrument's history covers, if it has any.
fn history_span(conn: &Connection, key: &str) -> Result<Option<(String, String)>> {
    let row: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT MIN(as_of), MAX(as_of) FROM price_history WHERE key = ?1",
            params![key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(oops)?;
    Ok(match row {
        (Some(first), Some(last)) => Some((first, last)),
        _ => None,
    })
}

/// A daily quote only ever adds today. Anything whose line doesn't already
/// reach a year back is worth fetching whole once — after which it never is
/// again, because the stored history keeps reaching further back every day.
///
/// Returns `(gold wants its history, scheme codes that want theirs)`.
pub fn price_backfill_needed(conn: &Connection) -> Result<(bool, Vec<String>)> {
    let (want_gold, schemes) = price_keys_needed(conn)?;
    let today = Utc::now().date_naive();
    let cutoff = (today - Duration::days(330)).format("%Y-%m-%d").to_string();
    let thin = |key: &str| -> Result<bool> {
        Ok(history_span(conn, key)?.is_none_or(|(first, _)| first > cutoff))
    };
    // Nothing tops gold's line up day by day — the spot quote is another feed
    // and stays out of it — so the fix is fetched again once its own end has
    // fallen a few days behind.
    let lagging = (today - Duration::days(3)).format("%Y-%m-%d").to_string();
    let stale = history_span(conn, KEY_GOLD)?.is_none_or(|(_, last)| last < lagging);
    // Gold's line is spot and the rupee folded together, so it is only as long
    // as the shorter of the two.
    let gold = want_gold && (thin(KEY_GOLD)? || stale || thin(KEY_FX)?);
    let mut wanted = Vec::new();
    for code in schemes {
        if thin(&format!("mf:{code}"))? {
            wanted.push(code);
        }
    }
    Ok((gold, wanted))
}

/// The date `days` ago, or `None` for "everything on file".
fn since_date(days: Option<i64>) -> Option<String> {
    days.map(|d| {
        (Utc::now().date_naive() - Duration::days(d.max(1)))
            .format("%Y-%m-%d")
            .to_string()
    })
}

/// One instrument's stored line, oldest first.
fn stored_series(conn: &Connection, key: &str, since: Option<&str>) -> Result<Vec<(String, Scaled)>> {
    let mut stmt = conn
        .prepare(
            "SELECT as_of, price_e4 FROM price_history
             WHERE key = ?1 AND (?2 IS NULL OR as_of >= ?2)
             ORDER BY as_of",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![key, since], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

/// Rupees a gram, day by day: spot gold in dollars folded with the rupee, the
/// landed-cost markup and the metal's purity — the same arithmetic
/// `PriceBook::price_for` does for today, run over the stored lines.
///
/// The two lines don't share holidays, so each gold fix takes the most recent
/// rupee rate on or before its own date. A dollar price is never converted at
/// a rate from the future.
fn gold_series(conn: &Connection, purity_e4: Scaled, since: Option<&str>) -> Result<Vec<PricePoint>> {
    // The rupee is read from the start of time regardless of the window, so
    // the first day inside it still has a rate to carry forward.
    let fx = stored_series(conn, KEY_FX, None)?;
    if fx.is_empty() {
        return Ok(Vec::new());
    }
    let landed = gold_landed_e4(conn)?;
    let mut points = Vec::new();
    let mut i = 0;
    for (as_of, usd_oz) in stored_series(conn, KEY_GOLD, since)? {
        while i + 1 < fx.len() && fx[i + 1].0 <= as_of {
            i += 1;
        }
        let inr = fx[i].1;
        points.push(PricePoint {
            as_of,
            price_e4: gold_price_e4(usd_oz, inr, landed, purity_e4),
        });
    }
    Ok(points)
}

fn fund_series(conn: &Connection, scheme_code: &str, since: Option<&str>) -> Result<Vec<PricePoint>> {
    Ok(stored_series(conn, &format!("mf:{scheme_code}"), since)?
        .into_iter()
        .map(|(as_of, price_e4)| PricePoint { as_of, price_e4 })
        .collect())
}

/// What one holding's own price has done. Empty until prices have been
/// fetched, and for a fund with no scheme behind it there is nothing to plot.
pub fn holding_series(conn: &Connection, id: &str, days: Option<i64>) -> Result<Vec<PricePoint>> {
    let row: Option<(String, Option<String>, Option<Scaled>)> = conn
        .query_row(
            "SELECT kind, scheme_code, purity_e4 FROM holdings WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(oops)?;
    let Some((kind, scheme_code, purity_e4)) = row else {
        return Ok(Vec::new());
    };
    let since = since_date(days);
    if kind == "gold" {
        gold_series(conn, purity_e4.unwrap_or(10_000), since.as_deref())
    } else {
        match scheme_code {
            Some(code) if !code.is_empty() => fund_series(conn, &code, since.as_deref()),
            _ => Ok(Vec::new()),
        }
    }
}

/// What one holding has been worth, day by day: the units held on each day at
/// that day's price. Not the same line as the scheme's NAV, which is a fact
/// about the fund rather than about you — it runs from the fund's inception,
/// it rises where you held nothing, and it says nothing about the ten
/// instalments you put in along the way.
pub fn holding_value_series(
    conn: &Connection,
    id: &str,
    days: Option<i64>,
) -> Result<Vec<ValuePoint>> {
    let line = holding_series(conn, id, days)?;
    if line.is_empty() {
        return Ok(Vec::new());
    }
    // Gold is weighed rather than traded, so the whole of it is held from the
    // day it was acquired; a fund is however much its lots have added up to
    // by the day being drawn.
    let (kind, grams_e4, acquired_on): (String, Scaled, Option<String>) = conn
        .query_row(
            "SELECT kind, grams_e4, acquired_on FROM holdings WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(oops)?;

    if kind == "gold" {
        return Ok(line
            .iter()
            .filter(|p| acquired_on.as_deref().is_none_or(|day| p.as_of.as_str() >= day))
            .map(|p| ValuePoint {
                as_of: p.as_of.clone(),
                value: market_value_paise(grams_e4, p.price_e4),
            })
            .collect());
    }

    // Every lot, oldest first, dated by the day its units landed — which is
    // what decides the day they start counting.
    let mut stmt = conn
        .prepare(
            "SELECT SUBSTR(COALESCE(allotted_at, occurred_at), 1, 10),
                    CASE WHEN kind = 'buy' THEN quantity_e4 ELSE -quantity_e4 END
             FROM investment_lots WHERE holding_id = ?1
             ORDER BY COALESCE(allotted_at, occurred_at)",
        )
        .map_err(oops)?;
    let lots: Vec<(String, Scaled)> = stmt
        .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);
    if lots.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut held: Scaled = 0;
    let mut next = 0;
    for point in &line {
        while next < lots.len() && lots[next].0 <= point.as_of {
            held += lots[next].1;
            next += 1;
        }
        // Before the first unit landed there is nothing of yours to draw.
        if held <= 0 && out.is_empty() {
            continue;
        }
        out.push(ValuePoint {
            as_of: point.as_of.clone(),
            value: market_value_paise(held.max(0), point.price_e4),
        });
    }
    Ok(out)
}

/// The same line for every holding at once, keyed by holding id — one round
/// trip behind a screen full of sparklines.
pub fn holding_value_series_all(
    conn: &Connection,
    days: Option<i64>,
) -> Result<HashMap<String, Vec<ValuePoint>>> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM holdings WHERE kind IN ('gold', 'fund')")
            .map_err(oops)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(oops)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(oops)?;
        rows
    };
    let mut out = HashMap::new();
    for id in ids {
        let line = holding_value_series(conn, &id, days)?;
        if !line.is_empty() {
            out.insert(id, line);
        }
    }
    Ok(out)
}

/// Every holding's line at once, keyed by holding id — one round trip for a
/// screen full of sparklines rather than one per card.
pub fn holding_series_all(conn: &Connection, days: Option<i64>) -> Result<HashMap<String, Vec<PricePoint>>> {
    let mut stmt = conn
        .prepare("SELECT id, kind, scheme_code, purity_e4 FROM holdings")
        .map_err(oops)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<Scaled>>(3)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    let since = since_date(days);
    // Every gold holding rides the same two lines, so they are folded once and
    // then rescaled per purity rather than re-read per holding.
    let pure = if rows.iter().any(|(_, kind, _, _)| kind == "gold") {
        gold_series(conn, 10_000, since.as_deref())?
    } else {
        Vec::new()
    };
    let mut out = HashMap::new();
    for (id, kind, scheme_code, purity_e4) in rows {
        let series = if kind == "gold" {
            let purity = purity_e4.unwrap_or(10_000);
            pure.iter()
                .map(|p| PricePoint {
                    as_of: p.as_of.clone(),
                    price_e4: div_round(p.price_e4 as i128 * purity as i128, 10_000) as Scaled,
                })
                .collect()
        } else {
            match scheme_code {
                Some(code) if !code.is_empty() => fund_series(conn, &code, since.as_deref())?,
                _ => Vec::new(),
            }
        };
        out.insert(id, series);
    }
    Ok(out)
}

/// What the gold you hold has been worth, day by day.
///
/// Weight is not kept by date — gold is a thing in a locker, not a position
/// with a history of trades — so the line is today's weight run back over the
/// market. It answers "what has the metal I own been doing", which is the
/// question the tab is asking, rather than "what was my locker worth in 2019".
///
/// `purity_e4` narrows it to the pieces of one fineness; `None` counts them
/// all. Each piece is valued exactly as the screen values it today, and the
/// day's total is their sum, so the last point on the line and the figure at
/// the top of the tab are the same number.
pub fn gold_value_series(
    conn: &Connection,
    days: Option<i64>,
    purity_e4: Option<Scaled>,
) -> Result<Vec<ValuePoint>> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(purity_e4, 10000), grams_e4, acquired_on FROM holdings
             WHERE kind = 'gold' AND closed_at IS NULL AND grams_e4 > 0",
        )
        .map_err(oops)?;
    let mut pieces: Vec<(Scaled, Scaled, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    if let Some(wanted) = purity_e4 {
        pieces.retain(|(purity, _, _)| *purity == wanted);
    }
    if pieces.is_empty() {
        return Ok(Vec::new());
    }

    // One folded line per fineness rather than one per piece: a dozen bangles
    // of the same karat ride the same rate, and the rate is the expensive part.
    let since = since_date(days);
    let mut lines: HashMap<Scaled, Vec<PricePoint>> = HashMap::new();
    for (purity, _, _) in &pieces {
        if !lines.contains_key(purity) {
            lines.insert(*purity, gold_series(conn, *purity, since.as_deref())?);
        }
    }

    let mut totals: HashMap<&str, Paise> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    // Dates come out of the fix in order, and every fineness shares them, so
    // walking the first line keeps the days in order without a second sort.
    if let Some(first) = pieces.first().and_then(|(p, _, _)| lines.get(p)) {
        for point in first {
            order.push(&point.as_of);
        }
    }
    for (purity, grams_e4, acquired_on) in &pieces {
        for point in &lines[purity] {
            // A piece counts from the day it came into your hands. One with no
            // date on it counts throughout: an unknown day is not a claim that
            // you didn't own it.
            if acquired_on.as_deref().is_some_and(|day| point.as_of.as_str() < day) {
                continue;
            }
            *totals.entry(&point.as_of).or_insert(0) +=
                market_value_paise(*grams_e4, point.price_e4);
        }
    }
    // Days before you owned anything drop out rather than plotting a run of
    // zeros: the line starts where the metal does. Once a piece is counted it
    // stays counted, so nothing goes missing out of the middle.
    Ok(order
        .into_iter()
        .filter_map(|as_of| {
            totals.get(as_of).map(|value| ValuePoint {
                as_of: as_of.to_string(),
                value: *value,
            })
        })
        .collect())
}

/// A fund's units as they arrived and left: signed changes, oldest first, each
/// on the day it was allotted rather than the day the money moved.
fn lot_quantities(conn: &Connection, holding_id: &str) -> Result<Vec<(NaiveDate, Scaled)>> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(l.allotted_at, l.occurred_at), l.kind, l.quantity_e4
             FROM investment_lots l WHERE l.holding_id = ?1",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![holding_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Scaled>(2)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    let mut out: Vec<(NaiveDate, Scaled)> = rows
        .into_iter()
        .filter_map(|(day, kind, quantity_e4)| {
            let day = NaiveDate::parse_from_str(day.get(..10)?, "%Y-%m-%d").ok()?;
            Some((day, if kind == "sell" { -quantity_e4 } else { quantity_e4 }))
        })
        .collect();
    out.sort_by_key(|(day, _)| *day);
    Ok(out)
}

/// What everything you hold has come to, day by day — one line for the whole
/// portfolio rather than one per holding.
pub fn portfolio_value_series(conn: &Connection, days: Option<i64>) -> Result<Vec<ValuePoint>> {
    sleeve_value_series(conn, days, None)
}

/// The same line for one sleeve of it: `Some("fund")`, `Some("gold")` or
/// `Some("deposit")` counts only those, and `None` counts the lot.
///
/// The three kinds are valued three different ways and none of them keep the
/// same calendar: a NAV is published on business days, a gold rate on the days
/// the fix runs, and a deposit has no market at all, only an accrual. So the
/// days are taken from whichever markets published one, each price is carried
/// across the days its own market was shut, and the deposits are worked out on
/// those same days. Nothing counts before the day it was yours, and the line
/// starts where the sleeve does rather than at a run of zeros.
pub fn sleeve_value_series(
    conn: &Connection,
    days: Option<i64>,
    sleeve: Option<&str>,
) -> Result<Vec<ValuePoint>> {
    let since = since_date(days);
    let today = Utc::now().date_naive();

    // What is closed is not part of what you hold, and counting it would walk
    // the line off a cliff on the day it went.
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, scheme_code, purity_e4, grams_e4, acquired_on, rate_e4, matures_on
             FROM holdings WHERE closed_at IS NULL",
        )
        .map_err(oops)?;
    let held = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<Scaled>>(3)?,
                r.get::<_, Scaled>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<Scaled>>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    if held.is_empty() {
        return Ok(Vec::new());
    }

    // Every gold holding rides the same line, rescaled per piece: a dozen
    // bangles of different karats share one market, and the market is the
    // expensive read.
    let pure = if held.iter().any(|h| h.1 == "gold") {
        gold_series(conn, 10_000, since.as_deref())?
    } else {
        Vec::new()
    };

    // A weight held from a day; units that come and go with the lots; and an
    // accrual with no market behind it at all.
    let mut weighed: Vec<(Vec<PricePoint>, Scaled, Option<NaiveDate>)> = Vec::new();
    let mut traded: Vec<(Vec<PricePoint>, Vec<(NaiveDate, Scaled)>)> = Vec::new();
    let mut earning: Vec<(Option<Scaled>, Option<String>, Vec<(NaiveDate, Paise)>)> = Vec::new();

    for (id, kind, scheme_code, purity_e4, grams_e4, acquired_on, rate_e4, matures_on) in held {
        // One sleeve's line leaves the others out. Deposits are two kinds
        // wearing one name, which is how the rest of the screen reads them.
        if let Some(want) = sleeve {
            let mine = if want == "deposit" { is_deposit(&kind) } else { kind == want };
            if !mine {
                continue;
            }
        }
        if is_deposit(&kind) {
            let mut paid = deposit_instalments(conn, &id)?;
            paid.sort_by_key(|(day, _)| *day);
            if !paid.is_empty() {
                earning.push((rate_e4, matures_on, paid));
            }
        } else if kind == "gold" {
            if grams_e4 <= 0 || pure.is_empty() {
                continue;
            }
            let purity = purity_e4.unwrap_or(10_000);
            let line = pure
                .iter()
                .map(|p| PricePoint {
                    as_of: p.as_of.clone(),
                    price_e4: div_round(p.price_e4 as i128 * purity as i128, 10_000) as Scaled,
                })
                .collect();
            weighed.push((
                line,
                grams_e4,
                acquired_on
                    .as_deref()
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()),
            ));
        } else {
            let line = match scheme_code {
                Some(code) if !code.is_empty() => fund_series(conn, &code, since.as_deref())?,
                _ => Vec::new(),
            };
            if line.is_empty() {
                continue;
            }
            traded.push((line, lot_quantities(conn, &id)?));
        }
    }

    // The days to plot on: every day some market published, plus today, so the
    // line ends on the same figure the cards quote.
    let mut axis: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (line, _, _) in &weighed {
        axis.extend(line.iter().map(|p| p.as_of.clone()));
    }
    for (line, _) in &traded {
        axis.extend(line.iter().map(|p| p.as_of.clone()));
    }
    // A book holding only deposits has no market days of its own. An accrual
    // is a smooth curve, so a point a week draws it as well as a point a day.
    if axis.is_empty() {
        let opened = earning
            .iter()
            .filter_map(|(_, _, paid)| paid.first().map(|(day, _)| *day))
            .min();
        let floor = since
            .as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        if let Some(opened) = opened {
            let mut day = floor.filter(|f| *f > opened).unwrap_or(opened);
            while day < today {
                axis.insert(day.format("%Y-%m-%d").to_string());
                day += Duration::days(7);
            }
        }
    }
    axis.insert(today.format("%Y-%m-%d").to_string());

    // Both the axis and everything read against it are in date order, so each
    // holding keeps a cursor and the whole line is one pass rather than a
    // search per day.
    let mut rate_at = vec![0usize; weighed.len()];
    let mut nav_at = vec![0usize; traded.len()];
    let mut lot_at = vec![0usize; traded.len()];
    let mut units = vec![0 as Scaled; traded.len()];
    let mut paid_at = vec![0usize; earning.len()];

    let mut out: Vec<ValuePoint> = Vec::with_capacity(axis.len());
    for as_of in &axis {
        let Ok(day) = NaiveDate::parse_from_str(as_of, "%Y-%m-%d") else {
            continue;
        };
        let mut total: Paise = 0;

        for (i, (line, grams_e4, from)) in weighed.iter().enumerate() {
            while rate_at[i] + 1 < line.len() && line[rate_at[i] + 1].as_of <= *as_of {
                rate_at[i] += 1;
            }
            let point = &line[rate_at[i]];
            // A piece counts from the day it came into your hands. One with no
            // date on it counts throughout: an unknown day is not a claim that
            // you did not own it.
            if point.as_of > *as_of || from.is_some_and(|owned| day < owned) {
                continue;
            }
            total += market_value_paise(*grams_e4, point.price_e4);
        }

        for (i, (line, lots)) in traded.iter().enumerate() {
            while lot_at[i] < lots.len() && lots[lot_at[i]].0 <= day {
                units[i] += lots[lot_at[i]].1;
                lot_at[i] += 1;
            }
            while nav_at[i] + 1 < line.len() && line[nav_at[i] + 1].as_of <= *as_of {
                nav_at[i] += 1;
            }
            let point = &line[nav_at[i]];
            if point.as_of > *as_of || units[i] <= 0 {
                continue;
            }
            total += market_value_paise(units[i], point.price_e4);
        }

        for (i, (rate_e4, matures_on, paid)) in earning.iter().enumerate() {
            while paid_at[i] < paid.len() && paid[paid_at[i]].0 <= day {
                paid_at[i] += 1;
            }
            if paid_at[i] == 0 {
                continue;
            }
            total += deposit_value(*rate_e4, matures_on.as_deref(), day, &paid[..paid_at[i]]);
        }

        out.push(ValuePoint {
            as_of: as_of.clone(),
            value: total,
        });
    }

    // Days before you held anything drop out rather than plotting a run of
    // zeros: the line starts where the portfolio does.
    let start = out.iter().position(|p| p.value != 0).unwrap_or(out.len());
    Ok(out.split_off(start))
}

/// What a gram has gone for, day by day, at whatever purity is asked for —
/// the rate behind every gold holding, which is a fact about the market rather
/// than about any one piece. `None` reads it as 24K.
pub fn gold_rate_series(
    conn: &Connection,
    days: Option<i64>,
    purity_e4: Option<Scaled>,
) -> Result<Vec<PricePoint>> {
    let purity = purity_e4.filter(|p| *p > 0 && *p <= 10_000).unwrap_or(10_000);
    gold_series(conn, purity, since_date(days).as_deref())
}

/// Holdings are worth what they would fetch today, but a purchase posts a
/// transfer, so its cost is already standing inside the investment account.
/// Only the revaluation on top of that basis is new money — hence an
/// adjustment rather than the whole market value.
///
/// Returns `(adjustment, market value)`.
/// What one holding is worth today, beside the basis its own postings already
/// put on the account it sits in.
#[derive(Default, Clone, Copy)]
struct Mark {
    market: Paise,
    posted: Paise,
}

/// Every holding valued at today's price and gathered by the account it sits
/// in. A holding that sits in no account has nothing to cancel against, so its
/// value goes to `unassigned` whole.
#[derive(Default)]
struct Marks {
    by_account: HashMap<String, Mark>,
    unassigned: Paise,
    /// What every holding is worth today, wherever it is parked.
    value: Paise,
}

fn holding_marks(conn: &Connection) -> Result<Marks> {
    let book = PriceBook::load(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT h.account_id, h.kind, h.scheme_code, h.purity_e4,
                    CASE WHEN h.kind = 'gold' THEN h.grams_e4 ELSE
                      COALESCE((SELECT SUM(CASE WHEN l.kind = 'buy' THEN l.quantity_e4
                                                ELSE -l.quantity_e4 END)
                                FROM investment_lots l WHERE l.holding_id = h.id), 0) END,
                    -- Exactly what this holding's postings contribute to its own
                    -- account's balance, read back off the ledger rather than off
                    -- the lots. Edit one of those transactions afterwards and both
                    -- sides move together instead of the basis being left behind.
                    COALESCE((SELECT SUM(CASE
                        WHEN t.kind = 'income'   AND t.account_id    = h.account_id THEN  t.amount
                        WHEN t.kind = 'expense'  AND t.account_id    = h.account_id THEN -t.amount
                        WHEN t.kind = 'transfer' AND t.account_id    = h.account_id THEN -t.amount
                        WHEN t.kind = 'transfer' AND t.to_account_id = h.account_id THEN  t.amount
                        ELSE 0 END)
                      FROM investment_lots l JOIN transactions t ON t.id = l.transaction_id
                      WHERE l.holding_id = h.id), 0),
                    h.id, h.rate_e4, h.matures_on
             FROM holdings h",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<Scaled>>(3)?,
                r.get::<_, Scaled>(4)?,
                r.get::<_, Paise>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<Scaled>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let mut marks = Marks::default();
    let today = Utc::now().date_naive();
    for (account_id, kind, scheme_code, purity_e4, units_e4, posted, id, rate_e4, matures_on)
        in rows
    {
        let market = if is_deposit(&kind) {
            // Worth what it has earned: each instalment compounds from the
            // day it was paid, so the sum is read per deposit.
            deposit_value(
                rate_e4,
                matures_on.as_deref(),
                today,
                &deposit_instalments(conn, &id)?,
            )
        } else {
            // Nothing fetched for it yet — leave the basis standing rather
            // than marking the position down to nothing on a first offline
            // launch.
            let Some((price_e4, _)) = book.price_for(&kind, scheme_code.as_deref(), purity_e4)
            else {
                continue;
            };
            market_value_paise(units_e4.max(0), price_e4)
        };
        marks.value += market;
        match account_id {
            Some(id) => {
                let entry = marks.by_account.entry(id).or_default();
                entry.market += market;
                entry.posted += posted;
            }
            None => marks.unassigned += market,
        }
    }
    Ok(marks)
}

/// Hangs each account's holdings off the ledger balance already read for it.
fn apply_marks(conn: &Connection, accounts: &mut [Account]) -> Result<()> {
    let marks = holding_marks(conn)?;
    // Resolved rather than created: reading a list of accounts is no reason
    // to write one into the book.
    let holding = debt_account_id(conn)?;
    for account in accounts.iter_mut() {
        if let Some(mark) = marks.by_account.get(&account.id) {
            account.revaluation = mark.market - mark.posted;
        }
        account.system = holding.as_deref() == Some(account.id.as_str());
    }
    Ok(())
}

/// What the holdings add to net worth over the accounts they are already
/// counted in, and what they are worth altogether.
fn investment_positions(conn: &Connection, accounts: &[Account]) -> Result<(Paise, Paise)> {
    let marks = holding_marks(conn)?;
    let mut adjustment = marks.unassigned;
    for account in accounts {
        let Some(mark) = marks.by_account.get(&account.id) else {
            continue;
        };
        // An archived account is already out of the account sum above, so
        // there is no basis left there to cancel.
        adjustment += mark.market - if account.archived { 0 } else { mark.posted };
    }
    Ok((adjustment, marks.value))
}

// ---------------------------------------------------------------- overview

/// The YYYY-MM-DD day out of a date or datetime, refusing anything that is
/// not a real one. Dates arrive from a form, so they are checked before they
/// are stored rather than blowing up in a later comparison.
fn day_of(text: &str, what: &str) -> Result<String> {
    let day = text.get(..10).unwrap_or(text);
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|_| format!("{what} is not a date Midas can read."))
}

pub(crate) fn month_bounds(month: &str) -> Result<(NaiveDate, NaiveDate)> {
    let start = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d")
        .map_err(|_| format!("`{month}` is not a YYYY-MM month."))?;
    let next = if start.month() == 12 {
        NaiveDate::from_ymd_opt(start.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(start.year(), start.month() + 1, 1)
    }
    .ok_or("Could not resolve the end of that month.")?;
    Ok((start, next.pred_opt().unwrap_or(next)))
}

pub(crate) fn shift_month(month: &str, delta: i32) -> Result<String> {
    let (start, _) = month_bounds(month)?;
    let total = start.year() * 12 + start.month() as i32 - 1 + delta;
    Ok(format!("{:04}-{:02}", total.div_euclid(12), total.rem_euclid(12) + 1))
}

/// Sum of income minus expense across every account within a window. Transfers
/// are internal movements, so they cancel out and are excluded entirely.
/// What the accounts the book still counts gained or lost, day by day.
///
/// Every posting is read from the point of view of the set of live accounts:
/// income into one adds, spending out of one subtracts, and a transfer only
/// counts when it crosses the edge of the set — money moved between two live
/// accounts nets to nothing, exactly as it should, while money moved into an
/// archived account really has left the figure the hero line draws.
///
/// The window is open at both ends: pass `None` for everything before a date,
/// which is how the line knows where it starts.
fn live_flow(
    conn: &Connection,
    live: &[String],
    from: Option<&str>,
    to: &str,
) -> Result<HashMap<String, Paise>> {
    if live.is_empty() {
        return Ok(HashMap::new());
    }
    let holes = vec!["?"; live.len()].join(",");
    let window = match from {
        Some(_) => "occurred_at >= ?a AND occurred_at <= ?b",
        None => "occurred_at < ?b",
    };
    // Two readings of the same ledger, added together: what each live account
    // did on its own side of a posting, and what arrived in one from outside.
    let sql = format!(
        "SELECT day, COALESCE(SUM(delta), 0) FROM (
            SELECT substr(occurred_at, 1, 10) AS day,
                   CASE WHEN kind = 'income' THEN amount ELSE -amount END AS delta
            FROM transactions
            WHERE account_id IN ({holes}) AND {window}
            UNION ALL
            SELECT substr(occurred_at, 1, 10), amount
            FROM transactions
            WHERE kind = 'transfer' AND to_account_id IN ({holes}) AND {window}
         ) GROUP BY day"
    )
    .replace("?a", "?")
    .replace("?b", "?");

    // The bindings run in the order the holes appear: the accounts and the
    // dates once for each half of the union.
    let mut args: Vec<String> = Vec::new();
    for _ in 0..2 {
        args.extend(live.iter().cloned());
        if let Some(from) = from {
            args.push(from.to_string());
        }
        args.push(to.to_string());
    }
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Paise>(1)?))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(oops)?;
    Ok(rows)
}

/// What came in and what went out over a window, refunds netted off. A
/// refund counts against the posting it names, on that posting's own date —
/// undoing a bill from March changes March, not the month the money landed.
fn flow_for(conn: &Connection, from: &str, to: &str) -> Result<(Paise, Paise)> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(CASE WHEN t.kind = 'income'  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.kind = 'expense'
                                      THEN MAX(0, t.amount - {REFUNDED} - {SHARED} - {CASHBACK}) ELSE 0 END), 0)
             FROM transactions t
             WHERE {NOT_A_REFUND} AND t.occurred_at >= ?1 AND t.occurred_at <= ?2"
        ),
        params![from, to],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(oops)
}

/// Spend for the window, grouped by top-level category with the leaf
/// categories kept underneath. Charts read the groups; the expandable
/// breakdown reads the children.
fn spend_by_category(conn: &Connection, from: &str, to: &str) -> Result<Vec<CategorySlice>> {
    spend_by_category_in(conn, from, to, None)
}

/// The same question asked of one account — what a card was spent on — or of
/// the whole book when no account is named.
pub(crate) fn spend_by_category_in(
    conn: &Connection,
    from: &str,
    to: &str,
    account: Option<&str>,
) -> Result<Vec<CategorySlice>> {
    let only = if account.is_some() { "AND t.account_id = ?3" } else { "" };
    let mut stmt = conn
        .prepare(
            &format!(
            "SELECT c.id, c.name, c.icon, c.color,
                    COALESCE(p.id, c.id)   AS group_id,
                    COALESCE(p.name, c.name),
                    COALESCE(p.icon, c.icon),
                    COALESCE(p.color, c.color),
                    SUM(t.net_amount),
                    SUM(CASE WHEN t.net_amount > 0 THEN 1 ELSE 0 END)
             FROM ({ATTRIBUTED}) t
             JOIN categories c ON c.id = t.category_id
             LEFT JOIN categories p ON p.id = c.parent_id
             WHERE t.kind = 'expense' AND {NOT_A_REFUND}
               AND t.occurred_at >= ?1 AND t.occurred_at <= ?2 {only}
             GROUP BY c.id
             -- A category whose every bill came back is not somewhere the
             -- money went, so it drops off the breakdown rather than sitting
             -- there at nothing.
             HAVING SUM(t.net_amount) > 0
             ORDER BY SUM(t.net_amount) DESC"
            ),
        )
        .map_err(oops)?;

    struct Leaf {
        slice: CategorySlice,
        group: (String, String, String, String),
    }

    let mut bound: Vec<&dyn rusqlite::ToSql> = vec![&from, &to];
    if let Some(id) = account.as_ref() {
        bound.push(id);
    }
    let leaves: Vec<Leaf> = stmt
        .query_map(params_from_iter(bound), |r| {
            Ok(Leaf {
                slice: CategorySlice {
                    category_id: r.get(0)?,
                    name: r.get(1)?,
                    icon: r.get(2)?,
                    color: r.get(3)?,
                    total: r.get(8)?,
                    count: r.get(9)?,
                    children: Vec::new(),
                },
                group: (r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?),
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    // Rows arrive largest-first, so groups keep that order as they appear.
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, CategorySlice> =
        std::collections::HashMap::new();

    for leaf in leaves {
        let (gid, gname, gicon, gcolor) = leaf.group;
        let entry = groups.entry(gid.clone()).or_insert_with(|| {
            order.push(gid.clone());
            CategorySlice {
                category_id: gid.clone(),
                name: gname,
                icon: gicon,
                color: gcolor,
                total: 0,
                count: 0,
                children: Vec::new(),
            }
        });
        entry.total += leaf.slice.total;
        entry.count += leaf.slice.count;
        // A parent that also holds transactions directly is not its own child.
        if leaf.slice.category_id != gid {
            entry.children.push(leaf.slice);
        }
    }

    let mut out: Vec<CategorySlice> = order
        .into_iter()
        .filter_map(|id| groups.remove(&id))
        .collect();
    out.sort_by(|a, b| b.total.cmp(&a.total));
    for group in &mut out {
        group.children.sort_by(|a, b| b.total.cmp(&a.total));
    }
    Ok(out)
}

/// `month` is the *last* month of the window and `span` how many months it
/// covers, so a single month, a quarter, a whole year and an arbitrary run of
/// months are all the same query with a different start.
pub fn overview(conn: &Connection, month: &str, span: u32) -> Result<Overview> {
    let span = span.max(1) as i32;
    let first_month = shift_month(month, -(span - 1))?;
    let (start, _) = month_bounds(&first_month)?;
    let (_, end) = month_bounds(month)?;
    let start_s = start.format("%Y-%m-%d").to_string();
    let end_s = format!("{}T23:59:59", end.format("%Y-%m-%d"));

    let accounts = list_accounts(conn)?;
    let live: Vec<&Account> = accounts.iter().filter(|a| !a.archived).collect();
    let net_worth: Paise = live.iter().map(|a| a.balance).sum();
    // An investment account holds the cost of what was bought rather than
    // money you could spend, so it is neither liquid nor — when a profitable
    // sale leaves it negative — anything you owe.
    let liquid: Paise = live
        .iter()
        .filter(|a| a.kind != "credit" && a.kind != "investment")
        .map(|a| a.balance)
        .sum();
    let account_debt: Paise = live
        .iter()
        .filter(|a| a.balance < 0 && a.kind != "investment")
        .map(|a| -a.balance)
        .sum();

    // Debts sit on the balance sheet too: what you are owed is an asset, what
    // you owe is a liability. Holdings sit there at what they are worth today.
    let (lent_outstanding, borrowed_outstanding) = debt_positions(conn)?;
    let (revaluation, investments) = investment_positions(conn, &accounts)?;
    let net_worth = net_worth + lent_outstanding - borrowed_outstanding + revaluation;
    let debt = account_debt + borrowed_outstanding;

    let (income, expense) = flow_for(conn, &start_s, &end_s)?;
    // The window immediately before this one, of the same length, so a year is
    // compared against the year before it rather than against a single month.
    let prev_month = shift_month(month, -span)?;
    let (pstart, _) = month_bounds(&shift_month(&prev_month, -(span - 1))?)?;
    let (_, pend) = month_bounds(&prev_month)?;
    let (prev_income, prev_expense) = flow_for(
        conn,
        &pstart.format("%Y-%m-%d").to_string(),
        &format!("{}T23:59:59", pend.format("%Y-%m-%d")),
    )?;

    // Per-day income and expense inside the window, twice over: as the money
    // actually moved, which is what the balance line is folded from, and as
    // it counts, which is the same less the refunds. A refund really did land
    // in the account — the balance says so — but it is not money earned, and
    // what it gave back was not money spent.
    let mut stmt = conn
        .prepare(
            &format!(
            "SELECT substr(t.occurred_at, 1, 10) AS day,
                    COALESCE(SUM(CASE WHEN t.kind = 'income'  THEN t.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.kind = 'income'  AND {NOT_A_REFUND}
                                      THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.kind = 'expense' AND {NOT_A_REFUND}
                                      THEN MAX(0, t.amount - {REFUNDED} - {SHARED} - {CASHBACK}) ELSE 0 END), 0)
             FROM transactions t
             WHERE t.occurred_at >= ?1 AND t.occurred_at <= ?2
             GROUP BY day ORDER BY day"
            ),
        )
        .map_err(oops)?;
    let per_day: HashMap<String, (Paise, Paise, Paise, Paise)> = stmt
        .query_map(params![start_s, end_s], |r| {
            Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(oops)?;

    // The line follows the accounts the figure above it is made of. An
    // archived account is out of net worth, so its money must be out of the
    // line too — otherwise the line ends a long way from the number it sits
    // under and neither explains the other.
    let live_ids: Vec<String> = live.iter().map(|a| a.id.clone()).collect();
    let opening_total: Paise = live.iter().map(|a| a.opening_balance).sum();
    let mut running: Paise = opening_total
        + live_flow(conn, &live_ids, None, &start_s)?
            .values()
            .sum::<Paise>();
    let live_per_day = live_flow(conn, &live_ids, Some(&start_s), &end_s)?;

    let mut daily_flow = Vec::new();
    // Where the window opens, before anything in it has happened. Without
    // this the first day's spending is already inside the first point, and a
    // month whose only movement was on the 1st draws a flat line.
    let mut balance_series = vec![running];
    let mut day = start;
    while day <= end {
        let key = day.format("%Y-%m-%d").to_string();
        let (_, _, net_inc, net_exp) = per_day.get(&key).copied().unwrap_or((0, 0, 0, 0));
        running += live_per_day.get(&key).copied().unwrap_or(0);
        balance_series.push(running);
        daily_flow.push(FlowPoint {
            bucket: key,
            income: net_inc,
            expense: net_exp,
        });
        day += Duration::days(1);
    }

    // Trailing twelve months of cash flow for the insights chart — or the
    // whole window, when it reaches back further than that.
    let months_back = span.max(12);
    let mut monthly_flow = Vec::new();
    for back in (0..months_back).rev() {
        let m = shift_month(month, -back)?;
        let (ms, me) = month_bounds(&m)?;
        let (i, e) = flow_for(
            conn,
            &ms.format("%Y-%m-%d").to_string(),
            &format!("{}T23:59:59", me.format("%Y-%m-%d")),
        )?;
        monthly_flow.push(FlowPoint {
            bucket: m,
            income: i,
            expense: e,
        });
    }

    let top_categories = spend_by_category(conn, &start_s, &end_s)?;

    let mut stmt = conn
        .prepare(
            &format!(
                "SELECT t.merchant, SUM(MAX(0, t.amount - {REFUNDED} - {SHARED} - {CASHBACK})), COUNT(*)
                 FROM transactions t
                 WHERE t.kind = 'expense' AND {NOT_A_REFUND} AND t.merchant <> ''
                   AND t.occurred_at >= ?1 AND t.occurred_at <= ?2
                 GROUP BY LOWER(t.merchant)
                 HAVING SUM(MAX(0, t.amount - {REFUNDED} - {SHARED} - {CASHBACK})) > 0
                 ORDER BY SUM(MAX(0, t.amount - {REFUNDED} - {SHARED} - {CASHBACK})) DESC LIMIT 6"
            ),
        )
        .map_err(oops)?;
    let top_merchants = stmt
        .query_map(params![start_s, end_s], |r| {
            Ok(MerchantSlice {
                merchant: r.get(0)?,
                total: r.get(1)?,
                count: r.get(2)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    Ok(Overview {
        month: month.to_string(),
        span: span as u32,
        net_worth,
        liquid,
        debt,
        lent_outstanding,
        borrowed_outstanding,
        investments,
        income,
        expense,
        prev_income,
        prev_expense,
        balance_series,
        daily_flow,
        monthly_flow,
        top_categories,
        top_merchants,
    })
}

// ------------------------------------------------------------------ demo

pub fn has_any_data(conn: &Connection) -> Result<bool> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
        .map_err(oops)?;
    Ok(n > 0)
}

pub fn setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(oops)
}

/// Every setting at once, for the app to hold while it runs. There are few of
/// them and they are all small, so a screen reads one out of memory rather
/// than asking the database each time it renders.
pub fn settings(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(oops)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(oops)?;
    Ok(rows)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(oops)?;
    Ok(())
}

/// Every table the book is made of, in an order that can be emptied and
/// refilled with the foreign keys looking on.
const TABLES: [&str; 18] = [
    "settings",
    "price_history",
    "price_cache",
    "folder_transactions",
    "folders",
    "template_labels",
    "template_splits",
    "transaction_templates",
    "debt_entries",
    "debt_additions",
    "debt_payments",
    "debts",
    "investment_lots",
    "holdings",
    "transaction_splits",
    "transactions",
    "categories",
    "accounts",
];

/// Writes the whole book to a file of its own.
///
/// `VACUUM INTO` rather than a copy of the file: the book is kept in WAL
/// mode, so what is on disk at any moment is missing whatever is still in the
/// log — and a backup that is missing the last hour is worse than none.
pub fn export_book(conn: &Connection, to: &Path) -> Result<()> {
    // The dialog has already asked about overwriting; SQLite refuses to.
    if to.exists() {
        std::fs::remove_file(to).map_err(oops)?;
    }
    conn.execute("VACUUM INTO ?1", params![to.to_string_lossy()])
        .map_err(oops)?;
    Ok(())
}

/// Reads a book back over this one, keeping a copy of what was here.
///
/// The rows are copied in rather than the file swapped underneath: the app
/// holds this connection open, and a file replaced beneath an open SQLite
/// connection is a corrupted one. The incoming book is brought up to the
/// current shape first, so a copy taken before a column existed still reads.
pub fn import_book(conn: &Connection, from: &Path, backup: &Path) -> Result<()> {
    if !from.exists() {
        return Err("That file is not there any more.".into());
    }
    {
        let incoming = Connection::open(from).map_err(oops)?;
        let mut stmt = incoming
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .map_err(|_| "That file isn't a database.".to_string())?;
        let names: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(oops)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(oops)?;
        for wanted in ["accounts", "transactions", "categories"] {
            if !names.iter().any(|n| n == wanted) {
                return Err("That file is a database, but not a Midas book.".into());
            }
        }
    }
    // Brought up to date on its own connection, so the columns line up.
    drop(open(from)?);

    export_book(conn, backup)?;
    conn.execute_batch("PRAGMA foreign_keys = OFF").map_err(oops)?;
    let result = (|| -> Result<()> {
        conn.execute("ATTACH DATABASE ?1 AS incoming", params![from.to_string_lossy()])
            .map_err(oops)?;
        let guard = conn.unchecked_transaction().map_err(oops)?;
        for table in TABLES {
            conn.execute(&format!("DELETE FROM main.{table}"), [])
                .map_err(oops)?;
            conn.execute(
                &format!("INSERT INTO main.{table} SELECT * FROM incoming.{table}"),
                [],
            )
            .map_err(oops)?;
        }
        guard.commit().map_err(oops)?;
        Ok(())
    })();
    let _ = conn.execute("DETACH DATABASE incoming", []);
    conn.execute_batch("PRAGMA foreign_keys = ON").map_err(oops)?;
    result
}

pub fn reset(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        // Lots go before transactions so SQLite has no SET NULL sweep to run
        // over them. `price_cache` stays: it is fetched data, not your book,
        // and keeping it means an offline relaunch can still value holdings.
        "DELETE FROM plan_entries; DELETE FROM plans;
         DELETE FROM investment_lots; DELETE FROM holdings;
         DELETE FROM debt_additions; DELETE FROM debt_payments; DELETE FROM debts;
         DELETE FROM template_splits; DELETE FROM template_labels;
         DELETE FROM transaction_templates;
         DELETE FROM folder_transactions; DELETE FROM folders;
         DELETE FROM transaction_splits; DELETE FROM transactions;
         DELETE FROM captures;
         DELETE FROM accounts; DELETE FROM categories; DELETE FROM settings;",
    )
    .map_err(oops)?;
    seed_categories(conn)
}

// ----------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// The hero line is the figure above it, drawn over time — so it counts
    /// the accounts that figure counts, and it starts where the window
    /// starts rather than after the first day has already happened.
    #[test]
    fn the_balance_line_opens_before_the_first_day_and_ignores_archived_money() {
        let conn = book();
        let live = account(&conn, "HDFC", "bank", 100_000_00);
        let shelved = account(&conn, "Old wallet", "cash", 500_000_00);
        set_account_archived(&conn, &shelved, true).unwrap();

        let categories = list_categories(&conn).unwrap();
        let food = categories.iter().find(|c| c.name == "Food & Drink").unwrap();
        save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 30_000_00,
                account_id: live.clone(),
                to_account_id: None,
                category_id: Some(food.id.clone()),
                merchant: "Big day".into(),
                note: None,
                occurred_at: "2026-09-01T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let over = overview(&conn, "2026-09", 1).unwrap();
        // A point for the opening level, then one for each of September's days.
        assert_eq!(over.balance_series.len(), 31);
        // The archived account's half a lakh is nowhere in it.
        assert_eq!(over.balance_series[0], 100_000_00);
        // And the first day is a fall, which is the whole point.
        assert_eq!(over.balance_series[1], 70_000_00);
        assert_eq!(*over.balance_series.last().unwrap(), 70_000_00);
    }

    /// The rule every one of these is circling: cash that has already been
    /// posted into an investment account is on the balance sheet once, so a
    /// holding may only ever add what it is worth *over* that basis.
    fn book() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn account(conn: &Connection, name: &str, kind: &str, opening: Paise) -> String {
        save_account(
            conn,
            AccountInput {
                id: None,
                name: name.into(),
                kind: kind.into(),
                institution: None,
                opening_balance: opening,
                color: "#000000".into(),
                icon: "wallet".into(),
            },
        )
        .unwrap()
        .id
    }

    /// A fund holding priced at a round ₹100 a unit, so the arithmetic in each
    /// test is checkable by eye.
    fn fund(conn: &Connection, account_id: Option<String>) -> String {
        save_holding(
            conn,
            HoldingInput {
                id: None,
                kind: "fund".into(),
                name: "Test Fund".into(),
                account_id,
                scheme_code: Some("999".into()),
                isin: None,
                purity_e4: None,
                grams_e4: None,
                acquired_on: None,
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        )
        .unwrap();
        conn.query_row("SELECT id FROM holdings LIMIT 1", [], |r| r.get(0))
            .unwrap()
    }

    fn price_at(conn: &Connection, rupees_per_unit: i64) {
        store_prices(
            conn,
            &[Quote {
                key: "mf:999".into(),
                price_e4: rupees_per_unit * 10_000,
                as_of: "2026-08-29".into(),
                source: "test".into(),
            }],
        )
        .unwrap();
    }

    fn buy(conn: &Connection, holding: &str, units: i64, paid: Paise, from: Option<&str>) {
        save_investment_lot(
            conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding.into(),
                kind: "buy".into(),
                quantity_e4: units * 10_000,
                amount: paid,
                occurred_at: "2026-08-01".into(),
                allotted_at: None,
                note: None,
                cash_account_id: from.map(str::to_string),
                transaction_id: None,
            },
        )
        .unwrap();
    }

    fn net_worth(conn: &Connection) -> Paise {
        overview(conn, "2026-08", 1).unwrap().net_worth
    }

    /// 24K gold at a spot price that lands on ₹100 a gram once duty, GST and
    /// the rupee are folded in, so the weight is the only moving part.
    fn gold(conn: &Connection, grams_e4: Scaled, account_id: Option<String>) -> String {
        save_holding(
            conn,
            HoldingInput {
                id: None,
                kind: "gold".into(),
                name: "Coins".into(),
                account_id,
                scheme_code: None,
                isin: None,
                purity_e4: Some(10_000),
                grams_e4: Some(grams_e4),
                acquired_on: None,
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        )
        .unwrap();
        conn.query_row("SELECT id FROM holdings WHERE kind = 'gold'", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    /// Spot dollars an ounce and the rupee, chosen so a gram of 24K comes to
    /// ₹100 flat at the default landed markup.
    fn gold_price_at(conn: &Connection, rupees_per_gram: i64) {
        let landed = gold_landed_e4(conn).unwrap();
        // Invert `gold_price_e4` for one ounce: price × troy grams ÷ landed.
        let usd_oz_e4 = rupees_per_gram * 311_035 * 10_000 / landed;
        store_prices(
            conn,
            &[
                Quote {
                    key: KEY_GOLD.into(),
                    price_e4: usd_oz_e4,
                    as_of: "2026-08-29".into(),
                    source: "test".into(),
                },
                Quote {
                    key: KEY_FX.into(),
                    price_e4: 10_000,
                    as_of: "2026-08-29".into(),
                    source: "test".into(),
                },
            ],
        )
        .unwrap();
    }

    /// A book written before gold stopped being traded: its lots fold into
    /// the holding's weight on the way in, rather than the metal vanishing.
    #[test]
    fn old_gold_lots_become_the_holdings_weight() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE holdings (
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
                 account_id TEXT, scheme_code TEXT, isin TEXT, purity_e4 INTEGER,
                 note TEXT, closed_at TEXT, created_at TEXT NOT NULL);
             CREATE TABLE investment_lots (
                 id TEXT PRIMARY KEY, holding_id TEXT NOT NULL, kind TEXT NOT NULL,
                 quantity_e4 INTEGER NOT NULL, amount INTEGER NOT NULL,
                 occurred_at TEXT NOT NULL, transaction_id TEXT,
                 note TEXT, created_at TEXT NOT NULL);
             INSERT INTO holdings (id, kind, name, purity_e4, created_at)
                 VALUES ('g', 'gold', 'Coins', 10000, '2026-01-01');
             INSERT INTO investment_lots
                 (id, holding_id, kind, quantity_e4, amount, occurred_at, created_at)
                 VALUES ('l1', 'g', 'buy', 200000, 100000, '2026-01-02', '2026-01-02'),
                        ('l2', 'g', 'sell', 50000, 40000, '2026-02-02', '2026-02-02');",
        )
        .unwrap();
        migrate(&conn).unwrap();

        let grams: Scaled = conn
            .query_row("SELECT grams_e4 FROM holdings WHERE id = 'g'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(grams, 150_000); // 20 g bought, 5 g sold.
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM investment_lots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn gold_is_valued_off_the_grams_you_typed() {
        let conn = book();
        account(&conn, "Savings", "bank", 500_000);
        gold(&conn, 250_000, None); // 25 g
        gold_price_at(&conn, 100);

        let holding = list_holdings(&conn).unwrap().pop().unwrap();
        assert_eq!(holding.units_e4, 250_000);
        assert_eq!(holding.market_value, 250_000);
        // There is no cost behind an object you were given or inherited, so
        // it reports no return rather than pretending its whole value is gain.
        assert_eq!(holding.invested, 0);
        assert_eq!(holding.total_return, 0);
        assert!(holding.lots.is_empty());

        // Nothing in the ledger backs it, so all ₹2,500 is new to the sheet.
        assert_eq!(net_worth(&conn), 500_000 + 250_000);
    }

    /// Entries recorded against a holding need not post anything — units
    /// bought before the book was started have no transaction behind them.
    /// Read the account's ledger alone and it looks empty, which is what the
    /// dashboard used to show for it.
    #[test]
    fn an_account_carries_what_the_holdings_in_it_are_worth() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Coin", "investment", 0);
        let holding = fund(&conn, Some(invest.clone()));
        buy(&conn, &holding, 10, 90_000, None); // nothing posted for it
        price_at(&conn, 100);

        let accounts = list_accounts(&conn).unwrap();
        let held = accounts.iter().find(|a| a.id == invest).unwrap();
        // The ledger still says nothing, and the ₹1,000 rides on top of it.
        assert_eq!(held.balance, 0);
        assert_eq!(held.revaluation, 100_000);
        // An account with no holding behind it is left exactly where it was.
        assert_eq!(accounts.iter().find(|a| a.id == bank).unwrap().revaluation, 0);

        // Counted once: the account's own worth is the whole of the change.
        assert_eq!(net_worth(&conn), 500_000 + 100_000);
    }

    /// A fund's buy does post into its account, so the account's worth is the
    /// units' market value — never the cost and the value both.
    #[test]
    fn a_funds_basis_is_cancelled_by_what_it_grew_into() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest.clone()));
        buy(&conn, &holding, 10, 100_000, Some(&bank));
        price_at(&conn, 120);

        let held = list_accounts(&conn)
            .unwrap()
            .into_iter()
            .find(|a| a.id == invest)
            .unwrap();
        assert_eq!(held.balance, 100_000); // ₹1,000 of cash went in...
        assert_eq!(held.revaluation, 20_000); // ...and is worth ₹1,200 today.
        assert_eq!(net_worth(&conn), 500_000 + 20_000);
    }

    #[test]
    fn gold_cannot_be_bought_or_sold_in_lots() {
        let conn = book();
        let holding = gold(&conn, 100_000, None);
        let err = save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding,
                kind: "buy".into(),
                quantity_e4: 10_000,
                amount: 100_000,
                occurred_at: "2026-08-01".into(),
                allotted_at: None,
                note: None,
                cash_account_id: None,
                transaction_id: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("tracked by the gram"), "{err}");
    }

    #[test]
    fn gold_needs_a_weight() {
        let conn = book();
        let err = save_holding(
            &conn,
            HoldingInput {
                id: None,
                kind: "gold".into(),
                name: "Coins".into(),
                account_id: None,
                scheme_code: None,
                isin: None,
                purity_e4: Some(9_160),
                grams_e4: None,
                acquired_on: None,
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("How many grams"), "{err}");
    }

    #[test]
    fn a_holding_that_never_touched_the_ledger_adds_its_whole_value() {
        let conn = book();
        account(&conn, "Savings", "bank", 500_000);
        let holding = fund(&conn, None);
        buy(&conn, &holding, 10, 90_000, None);
        price_at(&conn, 100);
        // Nothing was posted, so the ₹1,000 of units is new to the book.
        assert_eq!(net_worth(&conn), 500_000 + 100_000);
    }

    #[test]
    fn a_posted_purchase_only_converts_cash() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest));
        buy(&conn, &holding, 10, 100_000, Some(&bank));
        price_at(&conn, 100);
        // Units worth exactly what they cost: rupees moved, nothing was made.
        assert_eq!(net_worth(&conn), 500_000);

        // ...and that cost is no longer money you could spend.
        assert_eq!(overview(&conn, "2026-08", 1).unwrap().liquid, 400_000);
    }

    #[test]
    fn a_profitable_exit_keeps_its_gain() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest.clone()));
        buy(&conn, &holding, 10, 100_000, Some(&bank));
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding.clone(),
                kind: "sell".into(),
                quantity_e4: 100_000,
                amount: 120_000,
                occurred_at: "2026-08-20".into(),
                allotted_at: None,
                note: None,
                cash_account_id: Some(bank),
                transaction_id: None,
            },
        )
        .unwrap();
        price_at(&conn, 100);

        // The investment account is left ₹200 in the red — proceeds exceeded
        // the basis recorded against it — and that residue *is* the profit.
        assert_eq!(net_worth(&conn), 520_000);
        // Which is a gain, not something owed.
        assert_eq!(overview(&conn, "2026-08", 1).unwrap().debt, 0);
    }

    #[test]
    fn archiving_the_investment_account_changes_nothing() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest.clone()));
        buy(&conn, &holding, 10, 100_000, Some(&bank));
        price_at(&conn, 100);

        set_account_archived(&conn, &invest, true).unwrap();
        // The basis left the account sum with the account, so there is none
        // left to cancel — the units are simply worth what they are worth.
        assert_eq!(net_worth(&conn), 500_000);
    }

    #[test]
    fn a_holding_with_no_price_is_left_where_it_stands() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest));
        buy(&conn, &holding, 10, 100_000, Some(&bank));
        // No price fetched: valuing it at nothing would wipe the basis out.
        assert_eq!(net_worth(&conn), 500_000);
    }

    #[test]
    fn editing_the_posting_moves_the_basis_with_it() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest));
        buy(&conn, &holding, 10, 100_000, Some(&bank));
        price_at(&conn, 100);

        // Correct the transfer from the Transactions screen: ₹1,000 → ₹1,200.
        let tx = list_transactions(&conn, TransactionQuery::default()).unwrap();
        let transfer = tx.iter().find(|t| t.kind == "transfer").unwrap();
        save_transaction(
            &conn,
            TransactionInput {
                id: Some(transfer.id.clone()),
                kind: "transfer".into(),
                amount: 120_000,
                account_id: transfer.account_id.clone(),
                to_account_id: transfer.to_account_id.clone(),
                category_id: None,
                merchant: transfer.merchant.clone(),
                note: None,
                occurred_at: transfer.occurred_at.clone(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        // ₹1,200 paid for units worth ₹1,000, so the book is ₹200 lighter.
        // Reading the basis off the ledger is what keeps these in step.
        assert_eq!(net_worth(&conn), 480_000);
    }

    #[test]
    fn selling_more_than_is_held_is_refused() {
        let conn = book();
        let holding = fund(&conn, None);
        buy(&conn, &holding, 10, 100_000, None);
        let err = save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding,
                kind: "sell".into(),
                quantity_e4: 200_000,
                amount: 100_000,
                occurred_at: "2026-08-20".into(),
                allotted_at: None,
                note: None,
                cash_account_id: None,
                transaction_id: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("10"), "{err}");
    }

    /// The sample book is the first thing a new user sees, so its SIP history
    /// and the holding it feeds have to agree with each other exactly.
    #[test]
    fn the_sample_book_does_not_count_its_sips_twice() {
        let conn = book();
        crate::demo::seed(&conn).unwrap();
        let month = Utc::now().format("%Y-%m").to_string();

        let holdings = list_holdings(&conn).unwrap();
        assert_eq!(holdings.len(), 2);
        let gold = holdings.iter().find(|h| h.kind == "gold").unwrap();
        let sip = holdings.iter().find(|h| h.kind == "fund").unwrap();

        // Every SIP lot is backed by the transfer that paid for it...
        assert!(sip.lots.len() >= 12);
        assert!(sip.lots.iter().all(|l| l.transaction_id.is_some()));
        // ...and the gold predates the book, so none of its lots are.
        assert!(gold.lots.iter().all(|l| l.transaction_id.is_none()));

        // The investment account holds precisely what the SIPs put in, which
        // is what lets the revaluation cancel it cleanly.
        let account = list_accounts(&conn)
            .unwrap()
            .into_iter()
            .find(|a| a.id == *sip.account_id.as_ref().unwrap())
            .unwrap();
        assert_eq!(account.balance, sip.invested);

        // With no NAV yet, the fund contributes nothing over its basis.
        let before = overview(&conn, &month, 1).unwrap().net_worth;
        store_prices(
            &conn,
            &[Quote {
                key: format!("mf:{}", sip.scheme_code.as_ref().unwrap()),
                price_e4: 1_702_276,
                as_of: "2026-08-28".into(),
                source: "test".into(),
            }],
        )
        .unwrap();
        let after = overview(&conn, &month, 1).unwrap();
        let repriced = list_holdings(&conn)
            .unwrap()
            .into_iter()
            .find(|h| h.kind == "fund")
            .unwrap();

        // Pricing it moves net worth by the gain alone — never by the ₹1.95L
        // of cash that the SIP transfers already accounted for.
        assert_eq!(after.net_worth - before, repriced.market_value - account.balance);
        assert!(repriced.market_value > account.balance, "the sample book should show a gain");
    }

    /// Several funds can sit behind one investment account. Each lot's posting
    /// belongs to exactly one holding, so the basis partitions rather than
    /// being claimed twice.
    #[test]
    fn one_investment_account_can_back_many_funds() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 1_000_000);
        let invest = account(&conn, "Coin", "investment", 0);

        let make = |scheme: &str, name: &str| {
            save_holding(
                &conn,
                HoldingInput {
                    id: None,
                    kind: "fund".into(),
                    name: name.into(),
                    account_id: Some(invest.clone()),
                    scheme_code: Some(scheme.into()),
                    isin: None,
                    purity_e4: None,
                    grams_e4: None,
                    acquired_on: None,
                    note: None,
                    closed: None,
                    rate_e4: None,
                    opened_on: None,
                    instalment: None,
                    matures_on: None,
                },
            )
            .unwrap();
            conn.query_row(
                "SELECT id FROM holdings WHERE scheme_code = ?1",
                params![scheme],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        let flexi = make("111", "Flexi Cap");
        let index = make("222", "Nifty 50");

        buy(&conn, &flexi, 10, 100_000, Some(&bank)); // ₹1,000
        buy(&conn, &index, 20, 200_000, Some(&bank)); // ₹2,000

        // One account now holds ₹3,000 of basis for two different funds.
        let held = list_accounts(&conn)
            .unwrap()
            .into_iter()
            .find(|a| a.id == invest)
            .unwrap();
        assert_eq!(held.balance, 300_000);

        store_prices(
            &conn,
            &[
                Quote { key: "mf:111".into(), price_e4: 1_200_000, as_of: "2026-08-29".into(), source: "t".into() },
                Quote { key: "mf:222".into(), price_e4: 900_000, as_of: "2026-08-29".into(), source: "t".into() },
            ],
        )
        .unwrap();

        // 10 units at ₹120 = ₹1,200 (up ₹200); 20 at ₹90 = ₹1,800 (down ₹200).
        // They cancel, so net worth is exactly the cash it started with.
        assert_eq!(net_worth(&conn), 1_000_000);

        // And each fund reports its own position, not a share of the pot.
        let holdings = list_holdings(&conn).unwrap();
        let f = holdings.iter().find(|h| h.name == "Flexi Cap").unwrap();
        let i = holdings.iter().find(|h| h.name == "Nifty 50").unwrap();
        assert_eq!((f.market_value, f.total_return), (120_000, 20_000));
        assert_eq!((i.market_value, i.total_return), (180_000, -20_000));
    }

    /// Attaching a lot to a transfer you already recorded — the SIP you have
    /// been entering by hand — must value it exactly as if the lot had posted
    /// that transfer itself.
    #[test]
    fn linking_an_existing_transfer_counts_it_once() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);

        // The transfer already in the book, recorded by hand months ago.
        let tx = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 100_000,
                account_id: bank,
                to_account_id: Some(invest.clone()),
                category_id: None,
                merchant: "SIP".into(),
                note: None,
                occurred_at: "2026-08-05T08:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let holding = fund(&conn, Some(invest));
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding.clone(),
                kind: "buy".into(),
                quantity_e4: 100_000,
                amount: 100_000,
                occurred_at: "2026-08-05".into(),
                allotted_at: None,
                note: None,
                cash_account_id: None,
                transaction_id: Some(tx.id.clone()),
            },
        )
        .unwrap();
        price_at(&conn, 100);

        // No second transfer was written, and the units are worth what they
        // cost, so the book is exactly where it started.
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 1);
        assert_eq!(net_worth(&conn), 500_000);

        // Deleting the lot must leave that record alone — it was there first.
        let lot = list_holdings(&conn).unwrap()[0].lots[0].clone();
        assert!(!lot.owns_transaction);
        delete_investment_lot(&conn, &lot.id).unwrap();
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 1);
    }

    #[test]
    fn a_record_cannot_back_two_lots() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let tx = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 100_000,
                account_id: bank,
                to_account_id: Some(invest.clone()),
                category_id: None,
                merchant: "SIP".into(),
                note: None,
                occurred_at: "2026-08-05T08:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();
        let holding = fund(&conn, Some(invest));
        let mut link = |amount| {
            save_investment_lot(
                &conn,
                InvestmentLotInput {
                    id: None,
                    holding_id: holding.clone(),
                    kind: "buy".into(),
                    quantity_e4: 50_000,
                    amount,
                    occurred_at: "2026-08-05".into(),
                    allotted_at: None,
                    note: None,
                    cash_account_id: None,
                    transaction_id: Some(tx.id.clone()),
                },
            )
        };
        link(100_000).unwrap();
        // Sharing one posting would count its cost basis twice over.
        assert!(link(100_000).unwrap_err().contains("already attached"));
    }

    /// Attaching a transfer that went somewhere else — an import placeholder,
    /// the wrong investment account — repoints it at the holding rather than
    /// refusing. Otherwise that cash would sit in the other account while the
    /// units were counted on top of it.
    #[test]
    fn linking_a_transfer_repoints_it_at_the_holding() {
        let conn = book();
        let bank = account(&conn, "HDFC", "bank", 500_000);
        let unlinked = account(&conn, "Unlinked", "bank", 0);
        let invest = account(&conn, "Mutual Funds", "investment", 0);
        let tx = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 100_000,
                account_id: bank.clone(),
                to_account_id: Some(unlinked),
                category_id: None,
                merchant: "Transfer".into(),
                note: None,
                occurred_at: "2026-08-05T08:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let holding = fund(&conn, Some(invest.clone()));
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding,
                kind: "buy".into(),
                quantity_e4: 100_000,
                amount: 100_000,
                occurred_at: "2026-08-05".into(),
                allotted_at: None,
                note: None,
                cash_account_id: None,
                transaction_id: Some(tx.id.clone()),
            },
        )
        .unwrap();

        // The transfer now runs HDFC → Mutual Funds, and nothing else about it
        // moved: same amount, same day, same description.
        let moved = list_transactions(&conn, TransactionQuery::default())
            .unwrap()
            .into_iter()
            .find(|t| t.id == tx.id)
            .unwrap();
        assert_eq!(moved.account_id, bank);
        assert_eq!(moved.to_account_id, Some(invest));
        assert_eq!(moved.amount, 100_000);
        assert_eq!(moved.occurred_at, "2026-08-05T08:00");
        assert_eq!(moved.merchant, "Transfer");

        // And it is counted once: units worth what they cost leave the book
        // exactly where it started.
        price_at(&conn, 100);
        assert_eq!(net_worth(&conn), 500_000);
    }

    /// Repointing cannot turn a transfer into one that starts and ends in the
    /// same account.
    #[test]
    fn repointing_onto_its_own_other_side_is_refused() {
        let conn = book();
        let invest = account(&conn, "Mutual Funds", "investment", 0);
        let bank = account(&conn, "HDFC", "bank", 500_000);
        let tx = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 100_000,
                account_id: invest.clone(),
                to_account_id: Some(bank),
                category_id: None,
                merchant: "Transfer".into(),
                note: None,
                occurred_at: "2026-08-05T08:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();
        let holding = fund(&conn, Some(invest));
        let err = save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding,
                kind: "buy".into(),
                quantity_e4: 100_000,
                amount: 100_000,
                occurred_at: "2026-08-05".into(),
                allotted_at: None,
                note: None,
                cash_account_id: None,
                transaction_id: Some(tx.id),
            },
        )
        .unwrap_err();
        assert!(err.contains("two different accounts"), "{err}");
    }

    /// Finding the SIP you want to attach a lot to means searching by where
    /// the money went, or by what it was — not just by the merchant line.
    #[test]
    fn transfers_are_findable_by_destination_and_amount() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Index Funds", "investment", 0);
        save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 1_500_000, // ₹15,000
                account_id: bank,
                to_account_id: Some(invest),
                category_id: None,
                merchant: "SIP — Nifty 50".into(),
                note: None,
                occurred_at: "2026-08-05T08:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let find = |term: &str| {
            list_transactions(
                &conn,
                TransactionQuery { search: Some(term.into()), ..Default::default() },
            )
            .unwrap()
            .len()
        };

        assert_eq!(find("Nifty"), 1, "by merchant");
        assert_eq!(find("Savings"), 1, "by the account it left");
        assert_eq!(find("Index Funds"), 1, "by the account it landed in");
        assert_eq!(find("15000"), 1, "by amount");
        assert_eq!(find("15,000"), 1, "by amount as it is printed");
        assert_eq!(find("14000"), 0, "a different amount matches nothing");
    }

    /// "Money out of savings" and "money into it" are different questions, and
    /// only the side of the posting tells transfers apart.
    #[test]
    fn transfers_filter_by_which_side_the_account_is_on() {
        let conn = book();
        let savings = account(&conn, "Savings", "bank", 500_000);
        let funds = account(&conn, "Index Funds", "investment", 0);
        let mut transfer = |from: &str, to: &str, amount: Paise, what: &str| {
            save_transaction(
                &conn,
                TransactionInput {
                    id: None,
                    kind: "transfer".into(),
                    amount,
                    account_id: from.into(),
                    to_account_id: Some(to.into()),
                    category_id: None,
                    merchant: what.into(),
                    note: None,
                    occurred_at: "2026-08-05T08:00".into(),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
            )
            .unwrap();
        };
        transfer(&savings, &funds, 100_000, "SIP");
        transfer(&funds, &savings, 40_000, "Redemption");

        let ask = |side: Option<&str>| {
            list_transactions(
                &conn,
                TransactionQuery {
                    account_ids: Some(vec![savings.clone()]),
                    account_side: side.map(str::to_string),
                    ..Default::default()
                },
            )
            .unwrap()
            .into_iter()
            .map(|t| t.merchant)
            .collect::<Vec<_>>()
        };

        assert_eq!(ask(None).len(), 2, "either side");
        assert_eq!(ask(Some("from")), vec!["SIP"], "money leaving savings");
        assert_eq!(ask(Some("to")), vec!["Redemption"], "money arriving in it");
    }

    /// The totals above the ledger describe the filter, not the page. Loading
    /// a slice of the rows must not change what they say.
    #[test]
    fn totals_cover_every_match_not_just_the_loaded_page() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 0);
        for i in 0..10 {
            save_transaction(
                &conn,
                TransactionInput {
                    id: None,
                    kind: if i % 2 == 0 { "expense" } else { "income" }.into(),
                    amount: 1_000,
                    account_id: bank.clone(),
                    to_account_id: None,
                    category_id: None,
                    merchant: format!("Row {i}"),
                    note: None,
                    occurred_at: format!("2026-08-{:02}T10:00", i + 1),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
            )
            .unwrap();
        }

        let paged = TransactionQuery { limit: Some(3), ..Default::default() };
        assert_eq!(list_transactions(&conn, paged.clone()).unwrap().len(), 3);

        // Same query, and the summary still describes all ten.
        let summary = transaction_summary(&conn, paged).unwrap();
        assert_eq!(summary.count, 10);
        assert_eq!(summary.income, 5_000);
        assert_eq!(summary.expense, 5_000);

        // Paging walks the whole ledger without repeating or skipping a row.
        let mut seen = Vec::new();
        for page in 0..4 {
            seen.extend(
                list_transactions(
                    &conn,
                    TransactionQuery {
                        limit: Some(3),
                        offset: Some(page * 3),
                        ..Default::default()
                    },
                )
                .unwrap()
                .into_iter()
                .map(|t| t.id),
            );
        }
        let unique: std::collections::HashSet<_> = seen.iter().collect();
        assert_eq!(seen.len(), 10);
        assert_eq!(unique.len(), 10);

        // And a filter narrows the totals with it.
        let only_income = transaction_summary(
            &conn,
            TransactionQuery { kinds: Some(vec!["income".into()]), ..Default::default() },
        )
        .unwrap();
        assert_eq!(only_income.count, 5);
        assert_eq!(only_income.expense, 0);
    }

    /// A window is `span` months ending at `month`, and it is compared against
    /// the same length of time immediately before it — a year against a year.
    #[test]
    fn a_window_sums_its_own_months_and_compares_with_the_one_before() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 0);
        let spend = |month: &str, amount: Paise| {
            save_transaction(
                &conn,
                TransactionInput {
                    id: None,
                    kind: "expense".into(),
                    amount,
                    account_id: bank.clone(),
                    to_account_id: None,
                    category_id: None,
                    merchant: "Shop".into(),
                    note: None,
                    occurred_at: format!("{month}-15T10:00"),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
            )
            .unwrap();
        };
        // ₹100 a month through 2025, ₹200 a month through 2026 to date.
        for m in 1..=12 {
            spend(&format!("2025-{m:02}"), 10_000);
        }
        for m in 1..=8 {
            spend(&format!("2026-{m:02}"), 20_000);
        }

        let august = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!(august.expense, 20_000);
        assert_eq!(august.prev_expense, 20_000, "July, the month before");

        // The whole of 2025, against the twelve months before it.
        let year = overview(&conn, "2025-12", 12).unwrap();
        assert_eq!(year.expense, 120_000);
        assert_eq!(year.prev_expense, 0, "nothing was spent in 2024");
        assert_eq!(year.daily_flow.len(), 365, "a day per day of the window");
        assert_eq!(year.balance_series.last(), Some(&-120_000));

        // An arbitrary run of months — Nov 2025 through Feb 2026 — against the
        // four months before it, which were ₹100 apiece.
        let straddling = overview(&conn, "2026-02", 4).unwrap();
        assert_eq!(straddling.expense, 20_000 + 20_000 + 10_000 + 10_000);
        assert_eq!(straddling.prev_expense, 40_000);
        // Cash flow reaches back at least as far as the window itself does.
        assert!(overview(&conn, "2026-08", 20).unwrap().monthly_flow.len() >= 20);
    }

    /// An SIP is debited on one date and allotted at another day's NAV. The
    /// ledger posting belongs to the day the money moved; the units — and so
    /// the price they were bought at — belong to the day they landed.
    #[test]
    fn a_lot_keeps_the_allotment_date_apart_from_the_payment_date() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let invest = account(&conn, "Funds", "investment", 0);
        let holding = fund(&conn, Some(invest));
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding.clone(),
                kind: "buy".into(),
                quantity_e4: 100_000,
                amount: 100_000,
                occurred_at: "2026-08-05".into(),
                allotted_at: Some("2026-08-07".into()),
                note: None,
                cash_account_id: Some(bank),
                transaction_id: None,
            },
        )
        .unwrap();

        let lot = list_holdings(&conn)
            .unwrap()
            .into_iter()
            .find(|h| h.id == holding)
            .unwrap()
            .lots
            .remove(0);
        assert_eq!(lot.occurred_at, "2026-08-05");
        assert_eq!(lot.allotted_at.as_deref(), Some("2026-08-07"));

        // The transfer this lot wrote is dated when the money actually left.
        let tx = get_transaction(&conn, lot.transaction_id.as_deref().unwrap()).unwrap();
        assert!(tx.occurred_at.starts_with("2026-08-05"), "{}", tx.occurred_at);

        // Allotted the same day is the ordinary case, and stores no second date.
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: Some(lot.id.clone()),
                holding_id: holding.clone(),
                kind: "buy".into(),
                quantity_e4: 100_000,
                amount: 100_000,
                occurred_at: "2026-08-05".into(),
                allotted_at: Some("2026-08-05".into()),
                note: None,
                cash_account_id: None,
                transaction_id: None,
            },
        )
        .unwrap();
        let same_day: Option<String> = conn
            .query_row(
                "SELECT allotted_at FROM investment_lots WHERE id = ?1",
                params![lot.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(same_day, None);

        // And a date that is not one is refused rather than stored.
        let err = save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: holding,
                kind: "buy".into(),
                quantity_e4: 10_000,
                amount: 10_000,
                occurred_at: "2026-08-05".into(),
                allotted_at: Some("the 7th".into()),
                note: None,
                cash_account_id: None,
                transaction_id: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("allotment date"), "{err}");
    }

    /// A sub-category is a shade of its group: it is saved in the group's
    /// colour whatever it was given, and recolouring the group carries.
    #[test]
    fn sub_categories_wear_their_groups_colour() {
        let conn = book();
        let cat = |name: &str, color: &str, parent: Option<&str>| {
            save_category(
                &conn,
                CategoryInput {
                    id: None,
                    kind: "expense".into(),
                    name: name.into(),
                    icon: "circle-dashed".into(),
                    color: color.into(),
                    parent_id: parent.map(str::to_string),
                },
            )
            .unwrap()
        };

        let group = cat("Travel", "#118AE4", None);
        // Asking for a different colour does not get you one.
        let child = cat("Flights", "#F2724F", Some(&group.id));
        assert_eq!(child.color, "#118AE4");

        // Repainting the group repaints what is filed under it.
        save_category(
            &conn,
            CategoryInput {
                id: Some(group.id.clone()),
                kind: "expense".into(),
                name: "Travel".into(),
                icon: "circle-dashed".into(),
                color: "#42C251".into(),
                parent_id: None,
            },
        )
        .unwrap();
        let after = list_categories(&conn)
            .unwrap()
            .into_iter()
            .find(|c| c.id == child.id)
            .unwrap();
        assert_eq!(after.color, "#42C251");

        // Lifted back to the top, it keeps the colour it is wearing and is
        // free to be given another.
        let lifted = save_category(
            &conn,
            CategoryInput {
                id: Some(child.id.clone()),
                kind: "expense".into(),
                name: "Flights".into(),
                icon: "circle-dashed".into(),
                color: "#A855F7".into(),
                parent_id: None,
            },
        )
        .unwrap();
        assert_eq!(lifted.color, "#A855F7");
    }

    #[test]
    fn gold_folds_spot_the_rupee_and_purity_into_a_gram() {
        // $4456.3999/oz at ₹95.39, marked up 9%, at 22K.
        let price = gold_price_e4(44_563_999, 953_900, 10_900, 9_160);
        assert_eq!(price, 136_458_224); // ₹13,645.8224 a gram
        // 20.5 g of it, in paise.
        assert_eq!(market_value_paise(205_000, price), 27_973_936);

        // And the reason this is i128: the numerator alone is 500-odd times
        // what an i64 can hold.
        assert!(
            44_563_999_i128 * 953_900 * 10_900 * 9_160 > i64::MAX as i128,
            "the i128 in gold_price_e4 is load-bearing"
        );
    }

    /// A category to file things under, since the split tests are about where
    /// money lands rather than about what it was spent on.
    fn category(conn: &Connection, name: &str, parent: Option<String>) -> String {
        save_category(
            conn,
            CategoryInput {
                id: None,
                kind: "expense".into(),
                name: name.into(),
                icon: "circle-dashed".into(),
                color: "#000000".into(),
                parent_id: parent,
            },
        )
        .unwrap()
        .id
    }

    fn bill(conn: &Connection, account_id: &str, amount: Paise, category: Option<String>) -> Transaction {
        save_transaction(
            conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount,
                account_id: account_id.into(),
                to_account_id: None,
                category_id: category,
                merchant: "Toit".into(),
                note: None,
                occurred_at: "2026-08-15T20:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap()
    }

    fn part(amount: Paise, category: &str) -> TransactionSplitInput {
        TransactionSplitInput {
            id: None,
            amount,
            category_id: Some(category.into()),
            note: None,
        }
    }

    fn share(who: &str, amount: Paise) -> TransactionShareInput {
        TransactionShareInput {
            id: None,
            direction: "lent".into(),
            counterparty: who.into(),
            amount,
            due_on: None,
            note: None,
            from_split: None,
        }
    }

    /// The share of somebody who paid: what you owe them, not they you.
    fn owed_to(who: &str, amount: Paise) -> TransactionShareInput {
        TransactionShareInput { direction: "borrowed".into(), ..share(who, amount) }
    }

    /// Your share of a bill somebody else paid, saved the way the sheet saves
    /// it: against no account of yours, and owed to whoever paid it.
    fn paid_by(conn: &Connection, who: &str, amount: Paise) -> Transaction {
        save_transaction(
            conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount,
                account_id: String::new(),
                to_account_id: None,
                category_id: None,
                merchant: "Zostel".into(),
                note: None,
                occurred_at: "2026-08-15T20:00".into(),
                splits: None,
                shares: Some(vec![owed_to(who, amount)]),
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap()
    }

    /// Re-saves a posting with new parts, leaving everything else as it was.
    fn resplit(
        conn: &Connection,
        tx: &Transaction,
        splits: Option<Vec<TransactionSplitInput>>,
        shares: Option<Vec<TransactionShareInput>>,
    ) -> Result<Transaction> {
        save_transaction(
            conn,
            TransactionInput {
                id: Some(tx.id.clone()),
                kind: tx.kind.clone(),
                amount: tx.amount,
                account_id: tx.account_id.clone(),
                to_account_id: tx.to_account_id.clone(),
                category_id: tx.category_id.clone(),
                merchant: tx.merchant.clone(),
                note: tx.note.clone(),
                occurred_at: tx.occurred_at.clone(),
                splits,
                shares,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
    }

    #[test]
    fn a_split_bill_is_still_one_posting() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let tx = bill(&conn, &bank, 300_000, Some(food.clone()));

        let tx = resplit(&conn, &tx, Some(vec![part(200_000, &food), part(100_000, &drinks)]), None)
            .unwrap();
        assert_eq!(tx.splits.len(), 2);

        // The balance and the totals only ever saw one ₹3,000 expense.
        assert_eq!(get_account(&conn, &bank).unwrap().balance, 200_000);
        let summary = transaction_summary(&conn, TransactionQuery::default()).unwrap();
        assert_eq!(summary.count, 1);
        assert_eq!(summary.expense, 300_000);
    }

    #[test]
    fn the_parts_have_to_come_to_the_whole() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let tx = bill(&conn, &bank, 300_000, Some(food.clone()));

        let short = resplit(&conn, &tx, Some(vec![part(100_000, &food), part(100_000, &drinks)]), None);
        assert!(short.is_err(), "two thirds of a bill is not a split of it");
        let alone = resplit(&conn, &tx, Some(vec![part(300_000, &food)]), None);
        assert!(alone.is_err(), "one part is not a split");

        // And the failed attempts left nothing behind.
        assert!(get_transaction(&conn, &tx.id).unwrap().splits.is_empty());
    }

    #[test]
    fn spend_lands_under_the_category_each_part_was_filed_against() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let tx = bill(&conn, &bank, 300_000, Some(food.clone()));
        resplit(&conn, &tx, Some(vec![part(200_000, &food), part(100_000, &drinks)]), None).unwrap();

        let slices = overview(&conn, "2026-08", 1).unwrap().top_categories;
        let total: Paise = slices.iter().map(|s| s.total).sum();
        assert_eq!(total, 300_000, "the bill is counted once, however it is cut");
        let by_name = |name: &str| {
            slices.iter().find(|s| s.name == name).map(|s| s.total).unwrap_or(0)
        };
        assert_eq!(by_name("Food"), 200_000);
        assert_eq!(by_name("Drinks"), 100_000);
    }

    #[test]
    fn a_split_bill_is_found_by_any_of_its_categories() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let tx = bill(&conn, &bank, 300_000, Some(food.clone()));
        resplit(&conn, &tx, Some(vec![part(200_000, &food), part(100_000, &drinks)]), None).unwrap();

        let by_drinks = list_transactions(
            &conn,
            TransactionQuery { category_ids: Some(vec![drinks]), ..Default::default() },
        )
        .unwrap();
        assert_eq!(by_drinks.len(), 1, "the bill is filed under Drinks too");
        assert_eq!(by_drinks[0].id, tx.id);
    }

    #[test]
    fn splitting_with_people_opens_a_debt_each() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let tx = bill(&conn, &bank, 300_000, None);
        let tx = resplit(&conn, &tx, None, Some(vec![share("Suhruth", 100_000), share("Nikhil", 100_000)]))
            .unwrap();

        assert_eq!(tx.shares.len(), 2, "your own third is not a debt");
        let debts = list_debts(&conn).unwrap();
        assert_eq!(debts.len(), 2);
        assert!(debts.iter().all(|d| d.from_split && d.transaction_id.as_deref() == Some(tx.id.as_str())));
        assert_eq!(debts.iter().map(|d| d.outstanding).sum::<Paise>(), 200_000);

        // The money still left the account in full, and what is owed back of
        // it is an asset — but only your own third was spending.
        assert_eq!(get_account(&conn, &bank).unwrap().balance, 200_000);
        let o = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!(o.lent_outstanding, 200_000);
        assert_eq!(o.expense, 100_000);
    }

    /// A shared bill cut across categories: your part of it comes off each
    /// line in proportion, and the lines still add up to exactly your part.
    #[test]
    fn only_your_part_of_a_shared_bill_is_spending() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let tx = bill(&conn, &bank, 300_000, Some(food.clone()));
        resplit(
            &conn,
            &tx,
            Some(vec![part(200_000, &food), part(100_000, &drinks)]),
            Some(vec![share("Subash", 100_000), share("Harish", 100_001)]),
        )
        .unwrap();

        let o = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!(o.expense, 99_999);
        let total: Paise = o.top_categories.iter().map(|s| s.total).sum();
        assert_eq!(total, 99_999, "the parts add up to your part, not a paisa off");
        let by_name = |name: &str| {
            o.top_categories.iter().find(|s| s.name == name).map(|s| s.total).unwrap_or(0)
        };
        assert_eq!(by_name("Food"), 66_666);
        assert_eq!(by_name("Drinks"), 33_333);

        let summary = transaction_summary(&conn, TransactionQuery::default()).unwrap();
        assert_eq!(summary.expense, 99_999);
    }

    #[test]
    fn a_share_cannot_be_more_than_the_bill() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let tx = bill(&conn, &bank, 300_000, None);
        assert!(resplit(&conn, &tx, None, Some(vec![share("Suhruth", 400_000)])).is_err());
        assert!(list_debts(&conn).unwrap().is_empty());
    }

    /// Harish paid, and this is your share: it is spent, it is owed to him,
    /// and not a paisa of it leaves an account of yours until you pay him.
    #[test]
    fn a_bill_somebody_else_paid_is_spent_and_owed() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let before = net_worth(&conn);
        let tx = paid_by(&conn, "Harish", 40_000);

        assert_eq!(tx.account_id, debt_account(&conn).unwrap(), "spent out of Debts");
        assert_eq!(tx.shares.len(), 1);
        assert_eq!(tx.shares[0].direction, "borrowed");
        assert_eq!(tx.shares[0].counterparty, "Harish");
        assert_eq!(get_account(&conn, &bank).unwrap().balance, 500_000);
        let month = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!(month.expense, 40_000);
        assert_eq!(month.borrowed_outstanding, 40_000);
        assert_eq!(net_worth(&conn), before - 40_000);
    }

    /// Edited afterwards — another amount, a category — it is still Harish's
    /// to be paid back, it is still the same debt, and what was already paid
    /// him stays paid.
    #[test]
    fn editing_a_bill_somebody_else_paid_keeps_it_owed_to_them() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let tx = paid_by(&conn, "Harish", 40_000);
        let debt_id = tx.shares[0].debt_id.clone();
        save_debt_payment(
            &conn,
            DebtPaymentInput {
                id: None,
                debt_id: debt_id.clone(),
                amount: 10_000,
                occurred_at: "2026-08-20".into(),
                note: None,
                transaction_id: None,
                cash_account_id: Some(bank.clone()),
            },
        )
        .unwrap();

        let tx = save_transaction(
            &conn,
            TransactionInput {
                id: Some(tx.id.clone()),
                kind: "expense".into(),
                amount: 45_000,
                account_id: tx.account_id.clone(),
                to_account_id: None,
                category_id: Some(food.clone()),
                merchant: tx.merchant.clone(),
                note: None,
                occurred_at: tx.occurred_at.clone(),
                splits: None,
                shares: Some(vec![TransactionShareInput {
                    id: Some(debt_id.clone()),
                    ..owed_to("Harish", 45_000)
                }]),
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();
        assert_eq!(tx.category_id.as_deref(), Some(food.as_str()));
        let owed = &tx.shares[0];
        assert_eq!((owed.debt_id.as_str(), owed.direction.as_str()), (debt_id.as_str(), "borrowed"));
        assert_eq!((owed.amount, owed.paid, owed.outstanding), (45_000, 10_000, 35_000));

        // A save that leaves the shares alone leaves them as they were.
        let tx = resplit(&conn, &tx, None, None).unwrap();
        assert_eq!(tx.shares.len(), 1);
        assert_eq!(tx.shares[0].direction, "borrowed");
    }

    /// Turned round into money owed to you, left part owed, or owed to nobody,
    /// a bill on the Debts account would be spending that never left an
    /// account of yours and that nobody paid for — so none of them is saved.
    #[test]
    fn a_bill_somebody_else_paid_cannot_be_owed_to_you() {
        let conn = book();
        let tx = paid_by(&conn, "Harish", 40_000);

        assert!(resplit(&conn, &tx, None, Some(vec![share("Harish", 40_000)])).is_err(), "turned round");
        assert!(resplit(&conn, &tx, None, Some(vec![owed_to("Harish", 30_000)])).is_err(), "part owed");
        assert!(resplit(&conn, &tx, None, Some(vec![])).is_err(), "owed to nobody");
        let income = TransactionInput {
            id: Some(tx.id.clone()),
            kind: "income".into(),
            amount: tx.amount,
            account_id: tx.account_id.clone(),
            to_account_id: None,
            category_id: None,
            merchant: tx.merchant.clone(),
            note: None,
            occurred_at: tx.occurred_at.clone(),
            splits: None,
            shares: None,
            label_ids: None,
            refund_of: None,
            cashback: None,
        };
        assert!(save_transaction(&conn, income).is_err(), "money in");

        let debts = list_debts(&conn).unwrap();
        assert_eq!(debts.len(), 1);
        assert_eq!((debts[0].direction.as_str(), debts[0].principal), ("borrowed", 40_000));
    }

    /// Hiding a category is showing it inside out: the bills one finds are
    /// exactly the bills the other leaves out, a split bill goes with any of
    /// its categories, and an uncategorised one is never caught by either.
    #[test]
    fn hiding_a_category_leaves_out_exactly_what_showing_it_finds() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let meal = bill(&conn, &bank, 30_000, Some(food.clone()));
        let beer = bill(&conn, &bank, 20_000, Some(drinks.clone()));
        let both = bill(&conn, &bank, 30_000, Some(food.clone()));
        resplit(&conn, &both, Some(vec![part(20_000, &food), part(10_000, &drinks)]), None).unwrap();
        let loose = bill(&conn, &bank, 5_000, None);

        let ids = |q: TransactionQuery| {
            let mut v: Vec<String> = list_transactions(&conn, q).unwrap().into_iter().map(|t| t.id).collect();
            v.sort();
            v
        };
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        let shown = ids(TransactionQuery { category_ids: Some(vec![drinks.clone()]), ..Default::default() });
        let hidden = ids(TransactionQuery { exclude_category_ids: Some(vec![drinks.clone()]), ..Default::default() });
        assert_eq!(shown, sorted(vec![beer.id.clone(), both.id.clone()]));
        assert_eq!(hidden, sorted(vec![meal.id.clone(), loose.id.clone()]));

        let summary = transaction_summary(
            &conn,
            TransactionQuery { exclude_category_ids: Some(vec![drinks]), ..Default::default() },
        )
        .unwrap();
        assert_eq!((summary.count, summary.expense), (2, 35_000));
    }

    /// Who paid: your own bills on one side, the ones somebody else paid on
    /// the other, and nothing in both.
    #[test]
    fn paid_by_tells_your_bills_from_ones_somebody_else_paid() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let mine = bill(&conn, &bank, 30_000, None);
        let theirs = paid_by(&conn, "Harish", 40_000);

        let ids = |who: &str| {
            list_transactions(&conn, TransactionQuery { paid_by: Some(who.into()), ..Default::default() })
                .unwrap()
                .into_iter()
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("others"), vec![theirs.id.clone()]);
        assert_eq!(ids("me"), vec![mine.id.clone()]);
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 2);
    }

    /// The other side of it: a bill you paid out of your own account leaves
    /// the people on it owing you, never you owing them.
    #[test]
    fn a_bill_you_paid_cannot_leave_you_owing() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let tx = bill(&conn, &bank, 30_000, None);

        assert!(resplit(&conn, &tx, None, Some(vec![owed_to("Harish", 10_000)])).is_err());
        assert!(list_debts(&conn).unwrap().is_empty());
    }

    #[test]
    fn re_splitting_keeps_what_has_already_been_repaid() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let tx = bill(&conn, &bank, 300_000, None);
        let tx = resplit(&conn, &tx, None, Some(vec![share("Suhruth", 100_000), share("Nikhil", 100_000)]))
            .unwrap();
        let suhruth = tx.shares.iter().find(|s| s.counterparty == "Suhruth").unwrap();
        save_debt_payment(
            &conn,
            DebtPaymentInput {
                id: None,
                debt_id: suhruth.debt_id.clone(),
                amount: 40_000,
                occurred_at: "2026-08-20".into(),
                note: None,
                transaction_id: None,
                cash_account_id: None,
            },
        )
        .unwrap();

        // Nikhil drops out and Suhruth's share is corrected upwards.
        let tx = resplit(
            &conn,
            &tx,
            None,
            Some(vec![TransactionShareInput {
                id: Some(suhruth.debt_id.clone()),
                ..share("Suhruth", 150_000)
            }]),
        )
        .unwrap();

        assert_eq!(tx.shares.len(), 1);
        assert_eq!(tx.shares[0].paid, 40_000, "the repayment survived the edit");
        assert_eq!(tx.shares[0].outstanding, 110_000);
        assert_eq!(list_debts(&conn).unwrap().len(), 1, "Nikhil's share went with him");
    }

    #[test]
    fn a_debt_linked_by_hand_is_not_the_splits_to_remove() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let tx = bill(&conn, &bank, 300_000, None);
        save_debt(
            &conn,
            DebtInput {
                id: None,
                direction: "lent".into(),
                counterparty: "Amma".into(),
                principal: 50_000,
                opened_on: "2026-08-15".into(),
                due_on: None,
                note: None,
                transaction_id: Some(tx.id.clone()),
                settled: None,
            },
        )
        .unwrap();

        let tx = resplit(&conn, &tx, None, Some(vec![share("Suhruth", 100_000)])).unwrap();
        assert_eq!(tx.shares.len(), 1, "only the split's own shares are listed");
        resplit(&conn, &tx, None, Some(Vec::new())).unwrap();

        let debts = list_debts(&conn).unwrap();
        assert_eq!(debts.len(), 1);
        assert_eq!(debts[0].counterparty, "Amma");
    }

    #[test]
    fn changing_the_amount_drops_a_split_that_no_longer_describes_it() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 500_000);
        let food = category(&conn, "Food", None);
        let drinks = category(&conn, "Drinks", None);
        let tx = bill(&conn, &bank, 300_000, Some(food.clone()));
        let tx = resplit(&conn, &tx, Some(vec![part(200_000, &food), part(100_000, &drinks)]), None)
            .unwrap();

        let corrected = save_transaction(
            &conn,
            TransactionInput {
                id: Some(tx.id.clone()),
                kind: "expense".into(),
                amount: 250_000,
                account_id: bank.clone(),
                to_account_id: None,
                category_id: Some(food),
                merchant: tx.merchant.clone(),
                note: None,
                occurred_at: tx.occurred_at.clone(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();
        assert!(
            corrected.splits.is_empty(),
            "parts adding to the old figure would contradict the ledger"
        );
    }

    /// The one thing the two stored lines can't be trusted to do is share a
    /// calendar: London fixes gold on days the ECB doesn't publish a rate, and
    /// the other way about. Each fix converts at the last rate on or before it
    /// — never at one from a day that hadn't happened yet.
    #[test]
    fn a_gold_day_converts_at_the_last_rupee_on_or_before_it() {
        let conn = book();
        gold(&conn, 10 * 10_000, None);
        let landed = gold_landed_e4(&conn).unwrap();
        let ounce = |rupees_per_gram: i64| rupees_per_gram * 311_035 * 10_000 / landed;
        store_history(
            &conn,
            KEY_GOLD,
            &[
                ("2026-08-24".into(), ounce(100)),
                ("2026-08-25".into(), ounce(110)),
                ("2026-08-26".into(), ounce(120)),
            ],
        )
        .unwrap();
        // No rate published on the 25th: that day carries the 24th's.
        store_history(
            &conn,
            KEY_FX,
            &[("2026-08-24".into(), 10_000), ("2026-08-26".into(), 20_000)],
        )
        .unwrap();

        let line = gold_rate_series(&conn, None, None).unwrap();
        let rates: Vec<Scaled> = line.iter().map(|p| p.price_e4).collect();
        assert_eq!(
            rates,
            vec![100 * 10_000, 110 * 10_000, 240 * 10_000],
            "the 25th holds the 24th's rupee; the 26th doubles on its own"
        );
        assert_eq!(line[0].as_of, "2026-08-24", "oldest first, for plotting");
    }

    /// A 22K piece is the same market, scaled — so its line is the pure rate
    /// times its purity, to the paisa.
    #[test]
    fn a_holdings_line_is_scaled_by_its_purity() {
        let conn = book();
        save_holding(
            &conn,
            HoldingInput {
                id: None,
                kind: "gold".into(),
                name: "Bangles".into(),
                account_id: None,
                scheme_code: None,
                isin: None,
                purity_e4: Some(9_160),
                grams_e4: Some(20 * 10_000),
                acquired_on: None,
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        )
        .unwrap();
        let id: String = conn
            .query_row("SELECT id FROM holdings WHERE kind = 'gold'", [], |r| r.get(0))
            .unwrap();
        // The rupee comes with the quote; the metal's own line is the fix.
        gold_price_at(&conn, 100);
        let landed = gold_landed_e4(&conn).unwrap();
        store_history(
            &conn,
            KEY_GOLD,
            &[("2026-08-29".into(), 100 * 311_035 * 10_000 / landed)],
        )
        .unwrap();

        let pure = gold_rate_series(&conn, None, None).unwrap();
        let mine = holding_series(&conn, &id, None).unwrap();
        assert_eq!(pure.len(), 1);
        assert_eq!(mine[0].price_e4, pure[0].price_e4 * 9_160 / 10_000);
    }

    /// The tab's line has to land on the tab's figure: whatever a piece is
    /// worth today is what its last point says, summed over the lot.
    #[test]
    fn the_last_point_of_the_value_line_is_what_the_gold_is_worth_today() {
        let conn = book();
        gold(&conn, 10 * 10_000, None); // 10 g of 24K
        save_holding(
            &conn,
            HoldingInput {
                id: None,
                kind: "gold".into(),
                name: "Bangles".into(),
                account_id: None,
                scheme_code: None,
                isin: None,
                purity_e4: Some(9_160),
                grams_e4: Some(20 * 10_000),
                acquired_on: None,
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        )
        .unwrap();
        gold_price_at(&conn, 100);
        let landed = gold_landed_e4(&conn).unwrap();
        store_history(
            &conn,
            KEY_GOLD,
            &[
                ("2026-08-28".into(), 50 * 311_035 * 10_000 / landed),
                ("2026-08-29".into(), 100 * 311_035 * 10_000 / landed),
            ],
        )
        .unwrap();

        let today: Paise = list_holdings(&conn)
            .unwrap()
            .iter()
            .filter(|h| h.kind == "gold")
            .map(|h| h.market_value)
            .sum();
        let line = gold_value_series(&conn, None, None).unwrap();
        assert_eq!(line.len(), 2);
        assert_eq!(line[1].value, today, "the line ends where the tab's total is");
        // Half the rate, half the money — both pieces, one sum.
        assert_eq!(line[0].value, line[1].value / 2);

        let only_22k = gold_value_series(&conn, None, Some(9_160)).unwrap();
        assert!(
            only_22k[1].value < line[1].value,
            "narrowing to one fineness leaves the other pieces out"
        );
    }

    /// The whole book on one line, ending on the figure the cards quote:
    /// gold at the day's rate, a fund at its NAV and a deposit at what it has
    /// earned, all three read on the same days.
    #[test]
    fn the_portfolio_line_ends_on_what_everything_is_worth_today() {
        let conn = book();
        // Nothing here posts a transfer: the line is about what is held, and
        // where the money came from is another card's business.
        // The fund first — its helper reads back whichever holding is there.
        let units = fund(&conn, None);
        buy(&conn, &units, 10, 100_000, None);
        price_at(&conn, 100);
        store_history(
            &conn,
            "mf:999",
            &[
                ("2026-08-27".into(), 50 * 10_000),
                ("2026-08-28".into(), 100 * 10_000),
            ],
        )
        .unwrap();

        gold(&conn, 10 * 10_000, None); // 10 g of 24K
        gold_price_at(&conn, 100);
        let landed = gold_landed_e4(&conn).unwrap();
        let ounce = |rupees_a_gram: i64| rupees_a_gram * 311_035 * 10_000 / landed;
        store_history(
            &conn,
            KEY_GOLD,
            &[
                ("2026-08-27".into(), ounce(50)),
                ("2026-08-28".into(), ounce(100)),
            ],
        )
        .unwrap();

        let fd = deposit(&conn, "fd", None, 8.0, "2026-01-01", "2027-01-01");
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: fd,
                kind: "buy".into(),
                quantity_e4: 1,
                amount: 500_000,
                occurred_at: "2026-01-01".into(),
                allotted_at: None,
                note: None,
                cash_account_id: None,
                transaction_id: None,
            },
        )
        .unwrap();

        let today: Paise = list_holdings(&conn)
            .unwrap()
            .iter()
            .filter(|h| !h.closed)
            .map(|h| h.market_value)
            .sum();
        let line = portfolio_value_series(&conn, None).unwrap();

        assert!(line.len() >= 3, "a point per market day, and one for today");
        assert_eq!(
            line.last().unwrap().value,
            today,
            "the line ends where the card's total is"
        );
        // Both markets halved the day before, so the first point is lower —
        // but not by half, because the deposit was earning either way.
        let last = line.last().unwrap().value;
        assert!(line[0].value < last && line[0].value > last / 2);
        assert!(
            line.iter().all(|p| p.value > 0),
            "the line starts where the portfolio does, not at a run of zeros"
        );
    }

    /// A piece counts from the day it was acquired, so the line steps up when
    /// it arrives rather than pretending you held it all along.
    #[test]
    fn gold_counts_from_the_day_it_was_acquired() {
        let conn = book();
        save_holding(
            &conn,
            HoldingInput {
                id: None,
                kind: "gold".into(),
                name: "Coin".into(),
                account_id: None,
                scheme_code: None,
                isin: None,
                purity_e4: Some(10_000),
                grams_e4: Some(10 * 10_000),
                acquired_on: Some("2026-08-29".into()),
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        )
        .unwrap();
        gold_price_at(&conn, 100);
        let landed = gold_landed_e4(&conn).unwrap();
        let ounce = 100 * 311_035 * 10_000 / landed;
        store_history(
            &conn,
            KEY_GOLD,
            &[("2026-08-28".into(), ounce), ("2026-08-29".into(), ounce)],
        )
        .unwrap();

        let line = gold_value_series(&conn, None, None).unwrap();
        assert_eq!(line.len(), 1, "the 28th owned nothing, so it isn't a day");
        assert_eq!(line[0].as_of, "2026-08-29");
        assert_eq!(line[0].value, 100_000, "10 g at ₹100 the day it arrived");

        // A day it hasn't reached is metal you don't have.
        let err = save_holding(
            &conn,
            HoldingInput {
                id: None,
                kind: "gold".into(),
                name: "Later".into(),
                account_id: None,
                scheme_code: None,
                isin: None,
                purity_e4: Some(10_000),
                grams_e4: Some(10_000),
                acquired_on: Some("2099-01-01".into()),
                note: None,
                closed: None,
                rate_e4: None,
                opened_on: None,
                instalment: None,
                matures_on: None,
            },
        );
        assert!(err.is_err(), "an acquisition date in the future is refused");
    }

    /// Spot and the fix are different feeds that sit a couple of percent apart.
    /// Today's spot values the metal; it never joins the line, where it would
    /// put a step at the seam that no market made.
    #[test]
    fn todays_spot_stays_out_of_the_fix_line() {
        let conn = book();
        gold(&conn, 10 * 10_000, None);
        gold_price_at(&conn, 100);

        assert!(list_holdings(&conn).unwrap()[0].price_e4.is_some(), "valued");
        assert!(
            gold_rate_series(&conn, None, None).unwrap().is_empty(),
            "but not plotted — nothing has published a fix yet"
        );
    }

    /// Every refresh files its quote under that day, so a line grows one point
    /// at a time — and refreshing twice on one day still leaves one point.
    #[test]
    fn a_days_price_is_recorded_once_however_often_it_is_fetched() {
        let conn = book();
        let holding = fund(&conn, None);
        price_at(&conn, 100);
        price_at(&conn, 104);
        store_history(&conn, "mf:999", &[("2026-08-28".into(), 950_000)]).unwrap();

        let line = holding_series(&conn, &holding, None).unwrap();
        assert_eq!(line.len(), 2, "two days, however many fetches");
        assert_eq!(line[0].price_e4, 950_000);
        assert_eq!(line[1].price_e4, 1_040_000, "the day's last fetch wins");
    }

    /// A change over many rows applies where it can and says where it could
    /// not, rather than bending a posting to fit or quietly doing less than
    /// it claimed.
    #[test]
    fn a_bulk_edit_leaves_alone_what_it_cannot_apply_to() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 5_000_000);
        let other = account(&conn, "Cash", "cash", 0);
        let food = category(&conn, "Food", None);
        let travel = category(&conn, "Travel", None);
        let salary = save_category(
            &conn,
            CategoryInput {
                id: None,
                kind: "income".into(),
                name: "Salary".into(),
                icon: "briefcase".into(),
                color: "#000000".into(),
                parent_id: None,
            },
        )
        .unwrap()
        .id;

        let plain = bill(&conn, &bank, 100_000, Some(food.clone()));
        let bare = bill(&conn, &bank, 50_000, None);
        let split = bill(&conn, &bank, 300_000, Some(food.clone()));
        resplit(&conn, &split, Some(vec![part(200_000, &food), part(100_000, &travel)]), None)
            .unwrap();
        let moved = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 25_000,
                account_id: bank.clone(),
                to_account_id: Some(other.clone()),
                category_id: None,
                merchant: "Moved".into(),
                note: None,
                occurred_at: "2026-08-15T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let ids = vec![plain.id.clone(), bare.id.clone(), split.id.clone(), moved.id.clone()];
        let done = update_transactions(
            &conn,
            &ids,
            TransactionPatch { category_id: Some(travel.clone()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(done.changed, 2, "the two plain expenses take the category");
        assert_eq!(done.skipped, 2, "the transfer and the split bill do not");

        let filed = |id: &str| -> Option<String> {
            conn.query_row("SELECT category_id FROM transactions WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(filed(&plain.id).as_deref(), Some(travel.as_str()));
        assert_eq!(filed(&bare.id).as_deref(), Some(travel.as_str()));
        assert_eq!(filed(&split.id).as_deref(), Some(food.as_str()), "its parts decide");
        assert_eq!(filed(&moved.id), None, "a transfer is never categorised");

        // The other side of the ledger is not a category an expense can take.
        let wrong = update_transactions(
            &conn,
            &[plain.id.clone()],
            TransactionPatch { category_id: Some(salary), ..Default::default() },
        )
        .unwrap();
        assert_eq!((wrong.changed, wrong.skipped), (0, 1));
        assert_eq!(filed(&plain.id).as_deref(), Some(travel.as_str()), "left as it was");

        // Moving the money's own side over, and clearing what it was filed as.
        update_transactions(
            &conn,
            &[plain.id.clone()],
            TransactionPatch {
                account_id: Some(other.clone()),
                clear_category: Some(true),
                merchant: Some(" Chai ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let (acct, merchant): (String, String) = conn
            .query_row(
                "SELECT account_id, merchant FROM transactions WHERE id = ?1",
                params![plain.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(acct, other);
        assert_eq!(merchant, "Chai", "trimmed on the way in");
        assert_eq!(filed(&plain.id), None);

        // A transfer cannot be moved onto the account it already pays into.
        let collide =
            update_transactions(&conn, &[moved.id.clone()], TransactionPatch {
                account_id: Some(other.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!((collide.changed, collide.skipped), (0, 1));

        assert_eq!(delete_transactions(&conn, &[bare.id, split.id]).unwrap(), 2);
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 2);
    }

    /// Lending is not spending. Money out of your accounts with nowhere of
    /// yours to go is a transfer against a debt: the account falls, the debt
    /// stands in its place, and net worth never moves.
    #[test]
    fn a_transfer_with_nowhere_to_go_is_money_someone_owes() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 5_000_000);
        let before = net_worth(&conn);

        let lend = |shares: Option<Vec<TransactionShareInput>>| {
            save_transaction(
                &conn,
                TransactionInput {
                    id: None,
                    kind: "transfer".into(),
                    amount: 500_000,
                    account_id: bank.clone(),
                    to_account_id: None,
                    category_id: None,
                    merchant: "Harish".into(),
                    note: None,
                    occurred_at: "2026-08-14T10:00".into(),
                    splits: None,
                    shares,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
            )
        };

        assert!(lend(None).is_err(), "money cannot simply leave the book");
        let tx = lend(Some(vec![share("Harish", 500_000)])).unwrap();
        assert_eq!(tx.shares.len(), 1);
        assert_eq!(tx.shares[0].direction, "lent");

        let account_now = list_accounts(&conn).unwrap()[0].balance;
        assert_eq!(account_now, 5_000_000 - 500_000, "the money did leave");
        assert_eq!(net_worth(&conn), before, "but it is still yours, as a debt");

        // And it is not spending: the month's expenses never saw it.
        let month = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!(month.expense, 0);
        assert_eq!(month.lent_outstanding, 500_000);
    }

    /// A group is a heading: what it stands for is the sum of what is under
    /// it. A posting filed against the heading itself would be counted in the
    /// group and belong to none of its parts, so it is moved under one — and
    /// nothing can be filed there again.
    #[test]
    fn a_group_is_not_a_place_to_file_things() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 5_000_000);
        let health = category(&conn, "Health", None);
        let tx = bill(&conn, &bank, 100_000, Some(health.clone()));

        // Filed on it while it was a category in its own right, which it was.
        assert_eq!(get_transaction(&conn, &tx.id).unwrap().category_id.as_deref(), Some(health.as_str()));

        // Growing its first sub-category makes it a heading, and what was
        // filed on it goes under it.
        let pharmacy = category(&conn, "Pharmacy", Some(health.clone()));
        let moved = get_transaction(&conn, &tx.id).unwrap();
        assert_ne!(moved.category_id.as_deref(), Some(health.as_str()));
        assert_eq!(moved.category_name.as_deref(), Some("Others"));
        assert_eq!(moved.category_group_name.as_deref(), Some("Health"));

        // And it cannot be filed back on the heading, one way or the other.
        let direct = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 20_000,
                account_id: bank.clone(),
                to_account_id: None,
                category_id: Some(health.clone()),
                merchant: "Chemist".into(),
                note: None,
                occurred_at: "2026-08-16T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        );
        assert!(direct.is_err(), "a group cannot take a posting of its own");

        let one = bill(&conn, &bank, 60_000, Some(pharmacy.clone()));
        let parts = resplit(
            &conn,
            &one,
            Some(vec![part(30_000, &health), part(30_000, &pharmacy)]),
            None,
        );
        assert!(parts.is_err(), "nor a part of one");

        let sweep = update_transactions(
            &conn,
            &[one.id.clone()],
            TransactionPatch { category_id: Some(health.clone()), ..Default::default() },
        );
        assert!(sweep.is_err(), "nor a change made over many at once");

        // The `Others` it made is reused rather than piling up.
        let others: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM categories WHERE parent_id = ?1 AND name = 'Others'",
                params![health],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(others, 1);
    }

    /// A copy of the book is the whole book, and reading one back is the
    /// whole book again — with what was here kept beside it, because the
    /// commonest thing to do with an import is to have picked the wrong file.
    #[test]
    fn a_book_can_be_written_out_and_read_back() {
        let dir = std::env::temp_dir().join(format!("midas-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("copy.sqlite3");
        let backup = dir.join("kept.sqlite3");

        let conn = book();
        let bank = account(&conn, "Savings", "bank", 5_000_000);
        let food = category(&conn, "Food", None);
        bill(&conn, &bank, 100_000, Some(food.clone()));
        export_book(&conn, &copy).unwrap();

        // Everything after the copy is what reading it back has to undo.
        bill(&conn, &bank, 250_000, Some(food));
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 2);

        import_book(&conn, &copy, &backup).unwrap();
        let after = list_transactions(&conn, TransactionQuery::default()).unwrap();
        assert_eq!(after.len(), 1, "the book is the one that was written out");
        assert_eq!(after[0].amount, 100_000);
        assert_eq!(list_accounts(&conn).unwrap().len(), 1, "and its accounts with it");
        assert!(backup.exists(), "what was here is beside it");

        // A file that is not a book of ours is refused rather than emptying it.
        let junk = dir.join("junk.sqlite3");
        std::fs::write(&junk, b"this is not a database").unwrap();
        assert!(import_book(&conn, &junk, &dir.join("x.sqlite3")).is_err());
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn quantities_round_once_rather_than_per_lot() {
        // A third of a unit, three times over, at ₹90 — where valuing each lot
        // on its own and adding up would gain a paisa out of nowhere.
        let lots = [3_333, 3_333, 3_334];
        let per_lot: Paise = lots.iter().map(|q| market_value_paise(*q, 900_000)).sum();
        let once = market_value_paise(lots.iter().sum::<Scaled>(), 900_000);
        assert_eq!(per_lot, 9_001);
        assert_eq!(once, 9_000);
    }

    fn statement_row(date: &str, narration: &str, amount: Paise, direction: &str) -> StatementRow {
        StatementRow {
            date: date.into(),
            narration: narration.into(),
            ref_no: "0000123".into(),
            amount,
            direction: direction.into(),
            balance: None,
        }
    }

    /// The whole import loop: a row comes in unknown and lands in triage;
    /// confirming it teaches a rule; the next import of that counterparty
    /// arrives filed, and re-importing the same statement matches instead of
    /// doubling.
    #[test]
    fn imports_triage_and_learning() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 0);
        let cafe = statement_row(
            "2026-05-01",
            "UPI-BLUE TOKAI-BLUETOKAI@AXIS-UTIB0000001-645826-COFFEE",
            45_000,
            "debit",
        );

        // Unknown counterparty: a plain expense guess, no rule behind it.
        let preview = preview_import(&conn, &bank, vec![cafe.clone()]).unwrap();
        assert_eq!(preview[0].status, "new");
        assert_eq!(preview[0].kind, "expense");
        assert!(!preview[0].from_rule);

        let done = commit_import(
            &conn,
            &bank,
            vec![ImportCommitRow {
                row: cafe.clone(),
                input: TransactionInput {
                    id: None,
                    kind: "expense".into(),
                    amount: cafe.amount,
                    account_id: bank.clone(),
                    to_account_id: None,
                    category_id: None,
                    merchant: "Blue Tokai".into(),
                    note: None,
                    occurred_at: format!("{}T12:00", cafe.date),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
                triage: true,
                learn: false,
                affects_balance: true,
            }],
        )
        .unwrap();
        assert_eq!((done.inserted, done.triaged), (1, 1));
        assert_eq!((done.balance_neutral, done.opening_adjustment), (0, 0));

        let rows = list_transactions(&conn, TransactionQuery::default()).unwrap();
        assert_eq!(rows[0].labels.len(), 1);
        assert_eq!(rows[0].labels[0].name, TRIAGE_LABEL);

        // Only labelled rows come back when the query asks by label.
        let triage_only = list_transactions(
            &conn,
            TransactionQuery {
                label_ids: Some(vec![rows[0].labels[0].id.clone()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(triage_only.len(), 1);

        // Confirming clears the label and writes the rule down.
        assert_eq!(confirm_triage(&conn, &[rows[0].id.clone()]).unwrap(), 1);
        let rows = list_transactions(&conn, TransactionQuery::default()).unwrap();
        assert!(rows[0].labels.is_empty());

        // The same statement again: matched, not doubled.
        let again = preview_import(&conn, &bank, vec![cafe.clone()]).unwrap();
        assert_eq!(again[0].status, "matched");

        // A later visit to the same cafe: filed by the confirmed rule.
        let later = statement_row(
            "2026-06-09",
            "UPI-BLUE TOKAI-BLUETOKAI@AXIS-UTIB0000001-991122-FLAT WHITE",
            61_000,
            "debit",
        );
        let preview = preview_import(&conn, &bank, vec![later]).unwrap();
        assert_eq!(preview[0].status, "new");
        assert!(preview[0].from_rule && preview[0].rule_confirmed);
        assert_eq!(preview[0].merchant, "Blue Tokai");
    }

    /// A transfer rule names both of its ends, and applying it from the
    /// statement's side puts the money through the right way round.
    #[test]
    fn transfer_rules_keep_their_direction() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 0);
        let funds = account(&conn, "Funds", "investment", 0);
        let sip = statement_row(
            "2026-05-05",
            "ACH D- INDIAN CLEARING CORP-000000PKHMUL",
            1_000_000,
            "debit",
        );

        commit_import(
            &conn,
            &bank,
            vec![ImportCommitRow {
                row: sip.clone(),
                input: TransactionInput {
                    id: None,
                    kind: "transfer".into(),
                    amount: sip.amount,
                    account_id: bank.clone(),
                    to_account_id: Some(funds.clone()),
                    category_id: None,
                    merchant: "SIP".into(),
                    note: None,
                    occurred_at: format!("{}T12:00", sip.date),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
                triage: true,
                learn: false,
                affects_balance: true,
            }],
        )
        .unwrap();
        let rows = list_transactions(&conn, TransactionQuery::default()).unwrap();
        assert_eq!(rows[0].kind, "transfer");
        assert_eq!(rows[0].account_id, bank);
        assert_eq!(rows[0].to_account_id.as_deref(), Some(funds.as_str()));
        confirm_triage(&conn, &[rows[0].id.clone()]).unwrap();

        // Next month's debit of the same house: suggested as the same transfer.
        let next = statement_row(
            "2026-06-05",
            "ACH D- INDIAN CLEARING CORP-000000QQXYZ",
            1_000_000,
            "debit",
        );
        let preview = preview_import(&conn, &bank, vec![next]).unwrap();
        assert_eq!(preview[0].kind, "transfer");
        assert_eq!(preview[0].transfer_account_id.as_deref(), Some(funds.as_str()));
    }

    fn balance_of(conn: &Connection, id: &str) -> Paise {
        list_accounts(conn)
            .unwrap()
            .into_iter()
            .find(|a| a.id == id)
            .unwrap()
            .balance
    }

    fn commit_row(
        date: &str,
        amount: Paise,
        kind: &str,
        account: &str,
        other: Option<&str>,
    ) -> ImportCommitRow {
        ImportCommitRow {
            row: statement_row(
                date,
                &format!("UPI-SOMEONE-SOMEONE@AXIS-{date}"),
                amount,
                "debit",
            ),
            input: TransactionInput {
                id: None,
                kind: kind.into(),
                amount,
                account_id: account.into(),
                to_account_id: other.map(String::from),
                category_id: None,
                merchant: "Someone".into(),
                note: None,
                occurred_at: format!("{date}T12:00"),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
            triage: false,
            learn: false,
            affects_balance: true,
        }
    }

    /// A split written at import posts exactly like one written later from
    /// the sheet, and one that doesn't add up sinks the whole commit.
    #[test]
    fn imported_rows_can_arrive_split() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 0);
        let part = |amount: Paise| TransactionSplitInput {
            id: None,
            amount,
            category_id: None,
            note: None,
        };
        let mut row = commit_row("2026-05-02", 5_000, "expense", &bank, None);
        row.input.splits = Some(vec![part(3_000), part(2_000)]);
        commit_import(&conn, &bank, vec![row]).unwrap();
        let rows = list_transactions(&conn, TransactionQuery::default()).unwrap();
        assert_eq!(rows[0].splits.len(), 2);

        let mut bad = commit_row("2026-05-03", 5_000, "expense", &bank, None);
        bad.input.splits = Some(vec![part(3_000), part(1_000)]);
        assert!(commit_import(&conn, &bank, vec![bad]).is_err());
        // The failed commit left nothing half-done.
        assert_eq!(list_transactions(&conn, TransactionQuery::default()).unwrap().len(), 1);
    }

    /// A filing shaped by hand in the review teaches its rule at once, and
    /// labels set through the ordinary save stick and can be taken off —
    /// silent ones included, which travel with the posting so the sheet can
    /// unpin what it cannot draw.
    #[test]
    fn hand_edits_learn_and_labels_stick() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 0);
        let mut row = commit_row("2026-05-02", 5_000, "expense", &bank, None);
        row.learn = true;
        commit_import(&conn, &bank, vec![row]).unwrap();

        let next = statement_row(
            "2026-06-02",
            "UPI-SOMEONE-SOMEONE@AXIS-2026-06-02",
            7_000,
            "debit",
        );
        let preview = preview_import(&conn, &bank, vec![next]).unwrap();
        assert!(preview[0].from_rule && preview[0].rule_confirmed);

        let label = save_label(
            &conn,
            LabelInput {
                id: None,
                name: "Trip".into(),
                color: "#118AE4".into(),
                silent: false,
            },
        )
        .unwrap();
        let tx = list_transactions(&conn, TransactionQuery::default())
            .unwrap()
            .remove(0);
        let relabel = |ids: Vec<String>| TransactionInput {
            id: Some(tx.id.clone()),
            kind: tx.kind.clone(),
            amount: tx.amount,
            account_id: tx.account_id.clone(),
            to_account_id: None,
            category_id: None,
            merchant: tx.merchant.clone(),
            note: tx.note.clone(),
            occurred_at: tx.occurred_at.clone(),
            splits: None,
            shares: None,
            label_ids: Some(ids),
            refund_of: None,
            cashback: None,
        };
        let saved = save_transaction(&conn, relabel(vec![label.id.clone()])).unwrap();
        assert_eq!(saved.labels.len(), 1);
        assert_eq!(saved.labels[0].name, "Trip");
        assert!(!saved.labels[0].silent);

        // Silence is a property of the label, and it reaches the posting: the
        // pin still comes back, saying it is not to be drawn. Making one quiet
        // after the fact quiets it everywhere it is already pinned.
        let quiet = save_label(
            &conn,
            LabelInput {
                id: Some(label.id.clone()),
                name: "Trip".into(),
                color: "#118AE4".into(),
                silent: true,
            },
        )
        .unwrap();
        assert!(quiet.silent && quiet.count == 1);
        assert!(list_labels(&conn).unwrap().iter().any(|l| l.name == "Trip" && l.silent));
        let listed = list_transactions(&conn, TransactionQuery::default()).unwrap();
        assert!(listed[0].labels[0].silent);

        let saved = save_transaction(&conn, relabel(vec![])).unwrap();
        assert!(saved.labels.is_empty());

        // Deleting the label never touches the postings that wore it.
        delete_label(&conn, &label.id).unwrap();
        assert!(list_labels(&conn).unwrap().iter().all(|l| l.name != "Trip"));
    }

    fn deposit(conn: &Connection, kind: &str, account: Option<String>, rate_pct: f64,
               opened: &str, matures: &str) -> String {
        save_holding(
            conn,
            HoldingInput {
                id: None,
                kind: kind.into(),
                name: "Term deposit".into(),
                account_id: account,
                scheme_code: None,
                isin: None,
                purity_e4: None,
                grams_e4: None,
                acquired_on: None,
                rate_e4: Some((rate_pct * 10_000.0) as Scaled),
                opened_on: Some(opened.into()),
                instalment: None,
                matures_on: Some(matures.into()),
                note: None,
                closed: None,
            },
        )
        .unwrap();
        conn.query_row(
            "SELECT id FROM holdings WHERE kind = ?1 ORDER BY created_at DESC LIMIT 1",
            params![kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A deposit is worth what it has earned: quarterly compounding from the
    /// day each instalment went in, and nothing after maturity.
    #[test]
    fn deposits_earn_rather_than_being_priced() {
        // ₹1,00,000 at 8% for a year, compounded quarterly, is 1.08243 times
        // the principal — the figure a bank quotes on a one-year FD.
        let a_year = deposit_value(
            Some(80_000),
            Some("2027-01-01"),
            NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
            &[(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), 10_000_000)],
        );
        assert!((a_year - 10_824_300).abs() < 1_000, "got {a_year}");

        // Past maturity it stops: the same figure, whenever you look.
        let later = deposit_value(
            Some(80_000),
            Some("2027-01-01"),
            NaiveDate::from_ymd_opt(2029, 6, 1).unwrap(),
            &[(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), 10_000_000)],
        );
        assert_eq!(later, a_year);

        // No rate, no growth — a deposit recorded without its terms is worth
        // exactly what went into it rather than nothing.
        assert_eq!(
            deposit_value(None, None, NaiveDate::from_ymd_opt(2030, 1, 1).unwrap(),
                          &[(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), 5_000)]),
            5_000
        );
    }

    /// The money is already in the investment account; only what the deposit
    /// has earned on top is new.
    #[test]
    fn a_deposit_adds_only_its_interest_to_net_worth() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 1_000_000);
        let vault = account(&conn, "Deposits", "investment", 0);
        let fd = deposit(&conn, "fd", Some(vault.clone()), 8.0, "2026-01-01", "2027-01-01");
        save_investment_lot(
            &conn,
            InvestmentLotInput {
                id: None,
                holding_id: fd.clone(),
                kind: "buy".into(),
                // Deposits are measured by their money; the quantity is
                // filled in for us.
                quantity_e4: 1,
                amount: 500_000,
                occurred_at: "2026-01-01".into(),
                allotted_at: None,
                note: None,
                cash_account_id: Some(bank.clone()),
                transaction_id: None,
            },
        )
        .unwrap();

        // The transfer moved the money without spending it.
        assert_eq!(balance_of(&conn, &bank), 500_000);
        let held = list_holdings(&conn).unwrap();
        let held = held.iter().find(|h| h.id == fd).unwrap();
        assert_eq!(held.invested, 500_000);
        // Worth more than went in, and its maturity figure is quoted.
        assert!(held.market_value > 500_000);
        assert!(held.maturity_value > held.market_value);
        assert_eq!(held.total_return, held.market_value - 500_000);

        // Net worth is the accounts plus what the deposit has earned — the
        // principal is already sitting in the investment account.
        let accounts = list_accounts(&conn).unwrap();
        let vault_row = accounts.iter().find(|a| a.id == vault).unwrap();
        assert_eq!(vault_row.balance, 500_000);
        assert_eq!(vault_row.revaluation, held.market_value - 500_000);
    }

    /// A repayment that posts its own transfer moves the money into the
    /// account it landed in and leaves net worth where it was: what came
    /// back was already counted as owed.
    #[test]
    fn repayments_can_post_their_own_transfer() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 500_000);
        save_debt(
            &conn,
            DebtInput {
                id: None,
                direction: "lent".into(),
                counterparty: "Asha".into(),
                principal: 100_000,
                opened_on: "2026-08-01".into(),
                due_on: None,
                note: None,
                transaction_id: None,
                settled: None,
            },
        )
        .unwrap();
        let debt_id = list_debts(&conn).unwrap()[0].id.clone();
        // Lent but not yet posted: the money is out with her, and net worth
        // counts it as owed rather than as cash.
        let before = net_worth(&conn);
        assert_eq!(before, 500_000 + 100_000);

        save_debt_payment(
            &conn,
            DebtPaymentInput {
                id: None,
                debt_id: debt_id.clone(),
                amount: 40_000,
                occurred_at: "2026-08-20".into(),
                note: None,
                transaction_id: None,
                cash_account_id: Some(bank.clone()),
            },
        )
        .unwrap();

        // The money is in the account now, and no longer owed — so the total
        // has not moved, only what it is made of.
        assert_eq!(net_worth(&conn), before);
        let debt = &list_debts(&conn).unwrap()[0];
        assert_eq!(debt.paid, 40_000);
        assert_eq!(debt.outstanding, 60_000);
        let payment = &debt.payments[0];
        assert_eq!(payment.cash_account_id.as_deref(), Some(bank.as_str()));

        // The posting it wrote is a transfer into the account, against the
        // archived account that stands for what is out with people.
        let tx = get_transaction(&conn, payment.transaction_id.as_deref().unwrap()).unwrap();
        assert_eq!(tx.kind, "transfer");
        assert_eq!(tx.to_account_id.as_deref(), Some(bank.as_str()));
        assert_eq!(tx.account_name, DEBT_ACCOUNT);

        // Removing the repayment takes its posting with it, and the account
        // goes back to where it started.
        delete_debt_payment(&conn, &payment.id).unwrap();
        assert!(get_transaction(&conn, &tx.id).is_err());
        assert_eq!(net_worth(&conn), before);
    }

    /// Somebody on three bills pays once. The money clears the oldest bills
    /// first, one posting stands behind it, and it is changed and removed as
    /// the one repayment it is.
    #[test]
    fn a_repayment_spreads_over_everything_a_person_owes() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 500_000);
        for (who, amount, day) in [
            ("Subash", 36_700, "2026-09-26"),
            ("subash ", 131_600, "2026-09-27"),
            ("Subash", 76_600, "2026-10-02"),
            ("Asha", 10_000, "2026-09-01"),
        ] {
            save_debt(
                &conn,
                DebtInput {
                    id: None,
                    direction: "lent".into(),
                    counterparty: who.into(),
                    principal: amount,
                    opened_on: day.into(),
                    due_on: None,
                    note: None,
                    transaction_id: None,
                    settled: None,
                },
            )
            .unwrap();
        }
        let owed = |conn: &Connection, day: &str| {
            list_debts(conn)
                .unwrap()
                .into_iter()
                .find(|d| d.opened_on == day)
                .unwrap()
                .outstanding
        };
        let repay = |conn: &Connection, spread: Option<String>, amount: Paise| {
            save_person_repayment(
                conn,
                PersonRepaymentInput {
                    spread_id: spread,
                    direction: "lent".into(),
                    counterparty: "Subash".into(),
                    amount,
                    occurred_at: "2026-10-10".into(),
                    note: None,
                    transaction_id: None,
                    cash_account_id: Some(bank.clone()),
                },
            )
            .unwrap()
        };

        // Oldest first: the first two are cleared and the newest takes the rest.
        let spread = repay(&conn, None, 200_000);
        assert_eq!(owed(&conn, "2026-09-26"), 0);
        assert_eq!(owed(&conn, "2026-09-27"), 0);
        assert_eq!(owed(&conn, "2026-10-02"), 76_600 - 31_700);
        // Asha is somebody else, and nothing of it reached her.
        assert_eq!(owed(&conn, "2026-09-01"), 10_000);

        // One posting, for the whole of it.
        let pieces: Vec<DebtPayment> = list_debts(&conn)
            .unwrap()
            .into_iter()
            .flat_map(|d| d.payments)
            .collect();
        assert_eq!(pieces.len(), 3);
        let tx_id = pieces[0].transaction_id.clone().unwrap();
        assert!(pieces.iter().all(|p| p.transaction_id.as_deref() == Some(tx_id.as_str())));
        assert_eq!(get_transaction(&conn, &tx_id).unwrap().amount, 200_000);

        // A piece is not changed on its own.
        assert!(save_debt_payment(
            &conn,
            DebtPaymentInput {
                id: Some(pieces[0].id.clone()),
                debt_id: pieces[0].debt_id.clone(),
                amount: 1,
                occurred_at: "2026-10-10".into(),
                note: None,
                transaction_id: None,
                cash_account_id: None,
            },
        )
        .is_err());

        // Paid more than was owed: everything clears and the extra sits on
        // the newest. The same posting is rewritten, not a second one added.
        assert_eq!(repay(&conn, Some(spread.clone()), 254_900), spread);
        assert_eq!(owed(&conn, "2026-10-02"), 0);
        let newest = list_debts(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.opened_on == "2026-10-02")
            .unwrap();
        assert_eq!(newest.paid, 76_600 + 10_000);
        assert_eq!(get_transaction(&conn, &tx_id).unwrap().amount, 254_900);

        // Removing any piece removes the repayment, and its posting with it.
        delete_debt_payment(&conn, &newest.payments[0].id).unwrap();
        assert!(list_debts(&conn).unwrap().iter().all(|d| d.payments.is_empty()));
        assert!(get_transaction(&conn, &tx_id).is_err());
    }

    /// Lending more to somebody who already owes you raises what they owe by
    /// that much, posts the money out of the account it left, and leaves the
    /// figure the debt opened at alone — the form for editing the debt still
    /// changes that, and only that.
    #[test]
    fn more_can_be_added_to_an_open_debt() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 500_000);
        save_debt(
            &conn,
            DebtInput {
                id: None,
                direction: "lent".into(),
                counterparty: "Asha".into(),
                principal: 100_000,
                opened_on: "2026-08-01".into(),
                due_on: None,
                note: None,
                transaction_id: None,
                settled: None,
            },
        )
        .unwrap();
        let debt_id = list_debts(&conn).unwrap()[0].id.clone();
        let before = net_worth(&conn);

        save_debt_addition(
            &conn,
            DebtAdditionInput {
                id: None,
                debt_id: debt_id.clone(),
                amount: 50_000,
                occurred_at: "2026-09-02".into(),
                note: Some("for the deposit".into()),
                transaction_id: None,
                cash_account_id: Some(bank.clone()),
            },
        )
        .unwrap();

        let debt = &list_debts(&conn).unwrap()[0];
        assert_eq!(debt.opening, 100_000);
        assert_eq!(debt.added, 50_000);
        assert_eq!(debt.principal, 150_000);
        assert_eq!(debt.outstanding, 150_000);
        assert_eq!(debt.paid, 0);
        assert!(debt.payments.is_empty());
        let addition = &debt.additions[0];
        assert_eq!(addition.cash_account_id.as_deref(), Some(bank.as_str()));

        // Out of the bank and into what is out with people: the bank is
        // lower, she owes that much more, and the total has not moved.
        let tx = get_transaction(&conn, addition.transaction_id.as_deref().unwrap()).unwrap();
        assert_eq!(tx.kind, "transfer");
        assert_eq!(tx.account_id, bank);
        assert_eq!(tx.to_account_name.as_deref(), Some(DEBT_ACCOUNT));
        assert_eq!(net_worth(&conn), before);
        assert!(debt_entries(&conn, &debt_id).unwrap().iter().any(|t| t.id == tx.id));

        // Paying back the whole of it, the addition included, settles it.
        save_debt_payment(
            &conn,
            DebtPaymentInput {
                id: None,
                debt_id: debt_id.clone(),
                amount: 150_000,
                occurred_at: "2026-10-01".into(),
                note: None,
                transaction_id: None,
                cash_account_id: None,
            },
        )
        .unwrap();
        assert!(list_debts(&conn).unwrap()[0].settled);

        // Taking the addition off again takes its posting with it, and what
        // was repaid now more than covers what is owed.
        delete_debt_addition(&conn, &addition.id).unwrap();
        assert!(get_transaction(&conn, &tx.id).is_err());
        let debt = &list_debts(&conn).unwrap()[0];
        assert_eq!(debt.principal, 100_000);
        assert_eq!(debt.outstanding, 0);
    }

    /// Borrowing more runs the other way: the money lands in your account,
    /// and what you owe rises with it.
    #[test]
    fn borrowing_more_brings_the_money_in() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 0);
        save_debt(
            &conn,
            DebtInput {
                id: None,
                direction: "borrowed".into(),
                counterparty: "Ravi".into(),
                principal: 20_000,
                opened_on: "2026-08-01".into(),
                due_on: None,
                note: None,
                transaction_id: None,
                settled: None,
            },
        )
        .unwrap();
        let debt_id = list_debts(&conn).unwrap()[0].id.clone();
        save_debt_addition(
            &conn,
            DebtAdditionInput {
                id: None,
                debt_id,
                amount: 30_000,
                occurred_at: "2026-08-15".into(),
                note: None,
                transaction_id: None,
                cash_account_id: Some(bank.clone()),
            },
        )
        .unwrap();
        let debt = &list_debts(&conn).unwrap()[0];
        assert_eq!(debt.outstanding, 50_000);
        let tx = get_transaction(&conn, debt.additions[0].transaction_id.as_deref().unwrap()).unwrap();
        assert_eq!(tx.account_name, DEBT_ACCOUNT);
        assert_eq!(tx.to_account_id.as_deref(), Some(bank.as_str()));
    }

    /// A row the balance has already seen leaves every balance where it
    /// stood — the openings absorb it — while the rest move balances as
    /// usual, whatever their dates.
    fn template(conn: &Connection, name: &str, amount: Paise, account: &str) -> TxTemplate {
        save_template(
            conn,
            TxTemplateInput {
                id: None,
                name: name.into(),
                kind: "expense".into(),
                amount,
                account_id: Some(account.into()),
                to_account_id: None,
                category_id: None,
                merchant: "Landlord".into(),
                note: Some("  the rent  ".into()),
                splits: None,
                label_ids: None,
            },
        )
        .unwrap()
    }

    /// A template keeps the shape of a posting and gives it back whole —
    /// including the parts it was divided into and the labels it pins.
    #[test]
    fn a_template_keeps_the_shape_of_a_posting() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let food = category(&conn, "Food", None);
        let home = category(&conn, "Home", None);
        let label = ensure_label(&conn, "Monthly", "#F0B429").unwrap();

        let saved = save_template(
            &conn,
            TxTemplateInput {
                id: None,
                name: "  Friday shop  ".into(),
                kind: "expense".into(),
                amount: 300_000,
                account_id: Some(hdfc.clone()),
                to_account_id: None,
                category_id: Some(food.clone()),
                merchant: "  Big Basket  ".into(),
                note: None,
                splits: Some(vec![
                    TransactionSplitInput {
                        id: None,
                        amount: 200_000,
                        category_id: Some(food.clone()),
                        note: None,
                    },
                    TransactionSplitInput {
                        id: None,
                        amount: 100_000,
                        category_id: Some(home),
                        note: Some("soap".into()),
                    },
                ]),
                label_ids: Some(vec![label.clone()]),
            },
        )
        .unwrap();

        assert_eq!(saved.name, "Friday shop", "the name is trimmed");
        assert_eq!(saved.merchant, "Big Basket");
        assert_eq!(saved.account_name.as_deref(), Some("HDFC"));
        assert_eq!(saved.splits.len(), 2);
        assert_eq!(saved.splits.iter().map(|s| s.amount).sum::<Paise>(), 300_000);
        assert_eq!(saved.labels.len(), 1);
        assert_eq!(saved.used_count, 0);

        // And it reads back the same way out of the list.
        let listed = list_templates(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].splits.len(), 2);
        assert_eq!(listed[0].labels[0].name, "Monthly");
    }

    /// The parts of a template have to come to what the template says, for
    /// the same reason a posting's do: anything else is a figure that
    /// disagrees with itself.
    #[test]
    fn a_templates_parts_have_to_add_up() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let food = category(&conn, "Food", None);
        let err = save_template(
            &conn,
            TxTemplateInput {
                id: None,
                name: "Wrong".into(),
                kind: "expense".into(),
                amount: 300_000,
                account_id: Some(hdfc),
                to_account_id: None,
                category_id: None,
                merchant: String::new(),
                note: None,
                splits: Some(vec![
                    TransactionSplitInput { id: None, amount: 100_000, category_id: Some(food.clone()), note: None },
                    TransactionSplitInput { id: None, amount: 100_000, category_id: Some(food), note: None },
                ]),
                label_ids: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("parts come to"), "{err}");
    }

    /// Two templates cannot share a name — the name is how one is reached for
    /// — and saving over an existing one replaces it whole.
    #[test]
    fn a_template_is_replaced_by_name_rather_than_doubled() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let kept = template(&conn, "Rent", 2_500_000, &hdfc);
        assert_eq!(kept.note.as_deref(), Some("the rent"), "the note is trimmed");

        let clash = save_template(
            &conn,
            TxTemplateInput {
                id: None,
                name: "Rent".into(),
                kind: "expense".into(),
                amount: 1,
                account_id: Some(hdfc.clone()),
                to_account_id: None,
                category_id: None,
                merchant: String::new(),
                note: None,
                splits: None,
                label_ids: None,
            },
        )
        .unwrap_err();
        assert!(clash.contains("already a template called"), "{clash}");

        // The same name against the id it belongs to is a correction, not a clash.
        let changed = save_template(
            &conn,
            TxTemplateInput {
                id: Some(kept.id.clone()),
                name: "Rent".into(),
                kind: "expense".into(),
                amount: 2_600_000,
                account_id: Some(hdfc),
                to_account_id: None,
                category_id: None,
                merchant: "Landlord".into(),
                note: None,
                splits: None,
                label_ids: None,
            },
        )
        .unwrap();
        assert_eq!(changed.id, kept.id);
        assert_eq!(changed.amount, 2_600_000);
        assert_eq!(list_templates(&conn).unwrap().len(), 1);
    }

    /// A field left empty is empty in the template, and empty again every
    /// time it is used. That is how a template says "this one is different
    /// each time" — there is nothing else to set and nothing else to learn.
    #[test]
    fn a_blank_field_stays_blank() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let kept = save_template(
            &conn,
            TxTemplateInput {
                id: None,
                name: "Friday shop".into(),
                kind: "expense".into(),
                // No amount and no category: the two things that are never
                // the same twice about this one.
                amount: 0,
                account_id: Some(hdfc),
                to_account_id: None,
                category_id: None,
                merchant: "Big Basket".into(),
                note: None,
                splits: None,
                label_ids: None,
            },
        )
        .unwrap();

        assert_eq!(kept.amount, 0);
        assert_eq!(kept.category_id, None);
        assert_eq!(kept.note, None);
        assert_eq!(kept.merchant, "Big Basket", "what was filled in is kept");

        let listed = list_templates(&conn).unwrap();
        assert_eq!(listed[0].amount, 0, "and it reads back blank");
        assert_eq!(listed[0].category_name, None);
    }

    /// An empty name is the one blank a template cannot carry: the name is
    /// how it is reached for at all.
    #[test]
    fn a_template_still_needs_a_name() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let err = save_template(
            &conn,
            TxTemplateInput {
                id: None,
                name: "   ".into(),
                kind: "expense".into(),
                amount: 0,
                account_id: Some(hdfc),
                to_account_id: None,
                category_id: None,
                merchant: String::new(),
                note: None,
                splits: None,
                label_ids: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("needs a name"), "{err}");
    }

    /// An account deleted out from under a template leaves the template
    /// standing: what it says about the money is still worth keeping, and the
    /// sheet fills the account in from wherever it would have opened.
    #[test]
    fn a_template_outlives_the_account_it_named() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let kept = template(&conn, "Rent", 2_500_000, &hdfc);
        touch_template(&conn, &kept.id).unwrap();
        delete_account(&conn, &hdfc).unwrap();

        let listed = list_templates(&conn).unwrap();
        assert_eq!(listed.len(), 1, "the template stays");
        assert_eq!(listed[0].account_id, None, "the account it named does not");
        assert_eq!(listed[0].used_count, 1);
        assert!(listed[0].last_used_at.is_some());
    }

    /// Deleting a template touches nothing in the ledger: what it left behind
    /// are postings, and postings belong to the book.
    #[test]
    fn deleting_a_template_leaves_its_postings_alone() {
        let conn = book();
        let hdfc = account(&conn, "HDFC", "bank", 0);
        let kept = template(&conn, "Rent", 2_500_000, &hdfc);
        bill(&conn, &hdfc, 2_500_000, None);
        delete_template(&conn, &kept.id).unwrap();

        assert!(list_templates(&conn).unwrap().is_empty());
        assert_eq!(
            list_transactions(&conn, TransactionQuery::default()).unwrap().len(),
            1
        );
    }

    #[test]
    fn rows_marked_already_counted_leave_balances_alone() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 100_000);
        let funds = account(&conn, "Funds", "investment", 0);
        // The book's own record ends 1 June.
        save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 10_000,
                account_id: bank.clone(),
                to_account_id: None,
                category_id: None,
                merchant: "Latest".into(),
                note: None,
                occurred_at: "2026-06-01T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();
        assert_eq!(balance_of(&conn, &bank), 90_000);

        // An expense and a SIP the balance has already seen: recorded for
        // the record, but no balance anywhere moves — not the account's,
        // not the fund's, so not net worth either.
        let neutral = |mut r: ImportCommitRow| {
            r.affects_balance = false;
            r
        };
        let done = commit_import(
            &conn,
            &bank,
            vec![
                neutral(commit_row("2026-05-02", 5_000, "expense", &bank, None)),
                neutral(commit_row("2026-05-05", 20_000, "transfer", &bank, Some(&funds))),
            ],
        )
        .unwrap();
        assert_eq!(done.balance_neutral, 2);
        assert_eq!(done.opening_adjustment, 25_000);
        assert_eq!(balance_of(&conn, &bank), 90_000);
        assert_eq!(balance_of(&conn, &funds), 0);

        // Money the balance has yet to see moves it by exactly itself, and
        // the date has nothing to do with it: this one is older than both.
        let done = commit_import(
            &conn,
            &bank,
            vec![commit_row("2026-04-03", 7_000, "expense", &bank, None)],
        )
        .unwrap();
        assert_eq!((done.balance_neutral, done.opening_adjustment), (0, 0));
        assert_eq!(balance_of(&conn, &bank), 83_000);
    }

    // -------------------------------------------------------------- refunds

    /// A category by name, out of the ones every book is seeded with.
    fn filed_under(conn: &Connection, name: &str) -> String {
        list_categories(conn)
            .unwrap()
            .into_iter()
            .find(|c| c.name == name)
            .unwrap()
            .id
    }

    fn posting(
        conn: &Connection,
        kind: &str,
        account: &str,
        category: Option<&str>,
        amount: Paise,
        day: &str,
        refund_of: Option<&str>,
    ) -> Result<String> {
        save_transaction(
            conn,
            TransactionInput {
                id: None,
                kind: kind.into(),
                amount,
                account_id: account.into(),
                to_account_id: None,
                category_id: category.map(str::to_string),
                merchant: if refund_of.is_some() { "Shop refund" } else { "Shop" }.into(),
                note: None,
                occurred_at: format!("{day}T10:00"),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: refund_of.map(str::to_string),
                cashback: None,
            },
        )
        .map(|t| t.id)
    }

    fn spent(conn: &Connection, account: &str, category: &str, amount: Paise, day: &str) -> String {
        posting(conn, "expense", account, Some(category), amount, day, None).unwrap()
    }

    /// The shop hands it all back: the bill stops being spending, the refund
    /// never was any, and the account is where it started.
    #[test]
    fn a_refund_undoes_what_it_names() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let groceries = filed_under(&conn, "Groceries");
        let bill = spent(&conn, &bank, &groceries, 40_000, "2026-08-04");

        let before = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!(before.expense, 40_000);
        assert_eq!(balance_of(&conn, &bank), 60_000);

        posting(&conn, "income", &bank, None, 40_000, "2026-08-11", Some(&bill)).unwrap();

        let after = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!((after.expense, after.income), (0, 0));
        assert!(after.top_categories.is_empty());
        assert!(after.top_merchants.is_empty());
        // The money did leave and it did come back, so the balance says so.
        assert_eq!(balance_of(&conn, &bank), 100_000);
        assert_eq!(after.net_worth, 100_000);
    }

    /// Half of it back is half of it spent.
    #[test]
    fn a_part_refund_leaves_the_rest_standing() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let groceries = filed_under(&conn, "Groceries");
        let bill = spent(&conn, &bank, &groceries, 40_000, "2026-08-04");
        posting(&conn, "income", &bank, None, 15_000, "2026-08-11", Some(&bill)).unwrap();

        let after = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!((after.expense, after.income), (25_000, 0));
        assert_eq!(after.top_categories[0].total, 25_000);
        assert_eq!(after.top_merchants[0].total, 25_000);
        assert_eq!(balance_of(&conn, &bank), 75_000);
    }

    /// A refund counts against the month of the bill it undoes, not the month
    /// the money landed: nothing that was given back was ever spending.
    #[test]
    fn a_refund_lands_where_the_bill_was() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let groceries = filed_under(&conn, "Groceries");
        let bill = spent(&conn, &bank, &groceries, 40_000, "2026-07-20");
        posting(&conn, "income", &bank, None, 40_000, "2026-08-03", Some(&bill)).unwrap();

        let july = overview(&conn, "2026-07", 1).unwrap();
        assert_eq!((july.expense, july.income), (0, 0));
        let august = overview(&conn, "2026-08", 1).unwrap();
        assert_eq!((august.expense, august.income), (0, 0));
        // August is compared against a July that is likewise empty.
        assert_eq!((august.prev_expense, august.prev_income), (0, 0));
        assert!(august.daily_flow.iter().all(|d| d.income == 0 && d.expense == 0));
        // The balance still walks: out in July, back in August.
        assert_eq!(balance_of(&conn, &bank), 100_000);
    }

    /// A split bill gives back off its parts in order, so what is left of it
    /// still adds up to what it is now worth.
    #[test]
    fn a_refund_comes_off_the_parts_of_a_split_bill() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let groceries = filed_under(&conn, "Groceries");
        let taxi = filed_under(&conn, "Transport");
        let bill = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 40_000,
                account_id: bank.clone(),
                to_account_id: None,
                category_id: Some(groceries.clone()),
                merchant: "Shop".into(),
                note: None,
                occurred_at: "2026-08-04T10:00".into(),
                splits: Some(vec![
                    TransactionSplitInput {
                        id: None,
                        amount: 25_000,
                        category_id: Some(groceries.clone()),
                        note: None,
                    },
                    TransactionSplitInput {
                        id: None,
                        amount: 15_000,
                        category_id: Some(taxi.clone()),
                        note: None,
                    },
                ]),
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap()
        .id;
        posting(&conn, "income", &bank, None, 30_000, "2026-08-11", Some(&bill)).unwrap();

        let after = overview(&conn, "2026-08", 1).unwrap();
        // ₹300 off a ₹400 bill: the grocery line goes entirely, and ₹100 of
        // the taxi is all that is left standing.
        assert_eq!(after.expense, 10_000);
        assert_eq!(after.top_categories.len(), 1);
        assert_eq!(after.top_categories[0].name, "Transport");
        assert_eq!(after.top_categories[0].total, 10_000);
        // The breakdown and the header agree, which is the whole point of
        // taking it off the parts rather than off the bill.
        let breakdown: Paise = after.top_categories.iter().map(|c| c.total).sum();
        assert_eq!(breakdown, after.expense);
    }

    /// The ledger says what has come back, so a row can too.
    #[test]
    fn a_posting_carries_what_has_been_given_back() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let groceries = filed_under(&conn, "Groceries");
        let bill = spent(&conn, &bank, &groceries, 40_000, "2026-08-04");
        let back = posting(&conn, "income", &bank, None, 15_000, "2026-08-11", Some(&bill)).unwrap();

        let refunded = get_transaction(&conn, &bill).unwrap();
        assert_eq!(refunded.refunded, 15_000);
        assert_eq!(refunded.refund_of, None);

        let refund = get_transaction(&conn, &back).unwrap();
        assert_eq!(refund.refund_of.as_deref(), Some(bill.as_str()));
        assert_eq!(refund.refund_of_merchant.as_deref(), Some("Shop"));
        assert_eq!(refund.refund_of_amount, Some(40_000));
        assert_eq!(refund.refunded, 0);

        // Deleting what it gave back leaves an ordinary income behind rather
        // than a refund of nothing.
        delete_transaction(&conn, &bill).unwrap();
        assert_eq!(get_transaction(&conn, &back).unwrap().refund_of, None);
    }

    /// The rules that keep a refund readable: one posting, the other way,
    /// never more than was there, and never a chain.
    #[test]
    fn a_refund_is_held_to_the_posting_it_names() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let other = account(&conn, "Cash", "cash", 0);
        let groceries = filed_under(&conn, "Groceries");
        let bill = spent(&conn, &bank, &groceries, 40_000, "2026-08-04");

        // More than the bill was for.
        assert!(posting(&conn, "income", &bank, None, 50_000, "2026-08-11", Some(&bill)).is_err());
        // The same way as the bill.
        assert!(
            posting(&conn, "expense", &bank, Some(&groceries), 10_000, "2026-08-11", Some(&bill))
                .is_err()
        );
        // A transfer neither gives back nor is given back.
        let moved = save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 10_000,
                account_id: bank.clone(),
                to_account_id: Some(other.clone()),
                category_id: None,
                merchant: "Moved".into(),
                note: None,
                occurred_at: "2026-08-05T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap()
        .id;
        assert!(posting(&conn, "income", &bank, None, 5_000, "2026-08-11", Some(&moved)).is_err());

        // Two refunds are fine while they fit, and the second one that
        // doesn't is refused.
        posting(&conn, "income", &bank, None, 25_000, "2026-08-11", Some(&bill)).unwrap();
        let rest = posting(&conn, "income", &bank, None, 15_000, "2026-08-12", Some(&bill)).unwrap();
        assert!(posting(&conn, "income", &bank, None, 100, "2026-08-13", Some(&bill)).is_err());
        assert_eq!(overview(&conn, "2026-08", 1).unwrap().expense, 0);

        // A refund of a refund is refused from either end.
        assert!(posting(&conn, "expense", &bank, Some(&groceries), 100, "2026-08-14", Some(&rest)).is_err());
        // And a bill somebody has refunded cannot be corrected down below
        // what it has already handed back.
        let err = save_transaction(
            &conn,
            TransactionInput {
                id: Some(bill.clone()),
                kind: "expense".into(),
                amount: 10_000,
                account_id: bank.clone(),
                to_account_id: None,
                category_id: Some(groceries.clone()),
                merchant: "Shop".into(),
                note: None,
                occurred_at: "2026-08-04T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        );
        assert!(err.is_err());
    }

    /// A book written before refunds existed opens, grows the column, and
    /// indexes it — in that order, which is the whole of the bug this is here
    /// to keep out: the index cannot be created before the column it names.
    #[test]
    fn a_book_written_before_refunds_picks_them_up() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE transactions (
                 id            TEXT PRIMARY KEY,
                 kind          TEXT NOT NULL,
                 amount        INTEGER NOT NULL,
                 account_id    TEXT NOT NULL,
                 to_account_id TEXT,
                 category_id   TEXT,
                 merchant      TEXT NOT NULL DEFAULT '',
                 note          TEXT,
                 occurred_at   TEXT NOT NULL,
                 created_at    TEXT NOT NULL
             );",
        )
        .unwrap();
        migrate(&conn).unwrap();

        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_tx_refund'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1);
        // And the column is there to be read, which is what the index says.
        conn.query_row("SELECT COUNT(refund_of) FROM transactions", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    }

    /// The totals over a filtered list net the same way the dashboard does.
    #[test]
    fn the_ledgers_own_totals_net_the_refunds_off() {
        let conn = book();
        let bank = account(&conn, "Savings", "bank", 100_000);
        let groceries = filed_under(&conn, "Groceries");
        let bill = spent(&conn, &bank, &groceries, 40_000, "2026-08-04");
        spent(&conn, &bank, &groceries, 10_000, "2026-08-06");
        posting(&conn, "income", &bank, None, 40_000, "2026-08-11", Some(&bill)).unwrap();

        let summary = transaction_summary(&conn, TransactionQuery::default()).unwrap();
        // Three rows, all of them still there to be read — and ₹100 of
        // spending between them.
        assert_eq!(summary.count, 3);
        assert_eq!(summary.expense, 10_000);
        assert_eq!(summary.income, 0);
    }
}
