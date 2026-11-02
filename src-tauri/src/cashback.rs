//! Cashback: what a card gives back on what is spent on it.
//!
//! A card like Swiggy's gives back a share of every purchase — a rate, capped
//! at so much a cycle — and pays it as one credit the day the statement
//! closes. Two things follow, and the book keeps both:
//!
//! * **Each purchase cost less than it was.** The posting is what was paid,
//!   because that is what the card was charged and what the statement lists;
//!   its share of the cashback sits beside it, and every total counts the
//!   difference. Shares are handed out in the order the purchases were made,
//!   so a cap runs out on the last of a cycle rather than on all of it.
//! * **The cycle's cashback lands as a credit.** One a cycle, dated the day
//!   it closed, so the card owes what the bank says it owes. It is not money
//!   earned — the purchases already count it — so it is left out of every
//!   total the way a refund is.
//!
//! Nothing here is asked for. The rate and the cap are terms of the card,
//! kept with its limit and its cycle days, and `settle` works the rest out
//! from the ledger after anything changes: a purchase corrected, a refund, a
//! term moved, or nothing more than a cycle closing.

use std::collections::{BTreeMap, HashMap};

use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection};

use crate::cards::{card_terms, close_after, iso, terms_on, today};
use crate::db::{new_id, now, oops, Result, REFUNDED};
use crate::models::*;

/// What the credit a cycle's cashback lands as is called in the ledger.
const CREDIT_MERCHANT: &str = "Cashback";

/// What a card gives back on a day: a percentage scaled by 10^4, and the
/// most one cycle can earn. Zero is none, and no cap.
#[derive(Clone, Copy, Default)]
struct Offer {
    rate_e4: i64,
    cap: Paise,
}

/// The offer in force on a day. Unlike the card's other terms, nothing before
/// the first one recorded is read as the first: a card is on no offer until
/// the book is told it is, and whatever was written before then was written
/// as whatever it was — very often already less the cashback, by hand.
fn offer_on(terms: &[CardTerm], day: &str) -> Offer {
    let mut offer = Offer::default();
    for term in terms.iter().filter(|t| t.effective_on.as_str() <= day) {
        if let Some(rate) = term.cashback_rate_e4 {
            offer.rate_e4 = rate;
        }
        if let Some(cap) = term.cashback_cap {
            offer.cap = cap;
        }
    }
    offer
}

fn month_end(day: NaiveDate) -> NaiveDate {
    let (y, m) = if day.month() == 12 { (day.year() + 1, 1) } else { (day.year(), day.month() + 1) };
    NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|next| next.pred_opt())
        .unwrap_or(day)
}

/// The day the cycle a purchase made on `day` belongs to closes, which is the
/// day its cashback is credited. A card that keeps no cycle is credited by
/// the calendar month instead, on its last day.
pub(crate) fn closes_on(terms: &[CardTerm], live: Terms, day: NaiveDate) -> NaiveDate {
    if terms_on(terms, &iso(day), live).statement_day == 0 {
        return month_end(day);
    }
    close_after(day, terms, live)
        .filter(|close| *close >= day)
        .unwrap_or_else(|| month_end(day))
}

/// One purchase on a card, as far as cashback is concerned.
struct Purchase {
    id: String,
    /// The full timestamp, which is what the order of a cycle is read by.
    at: String,
    day: NaiveDate,
    amount: Paise,
    /// Refunded already: a purchase given back earns nothing on what came
    /// back, since the bank takes that share of the cashback back too.
    refunded: Paise,
    /// What it was said to have earned, by hand.
    set: Option<Paise>,
    /// What the book has on it now.
    had: Paise,
}

/// Every purchase on the card, oldest first. A refund is never a purchase,
/// and neither is the credit cashback itself lands as.
fn purchases(conn: &Connection, card: &str) -> Result<Vec<Purchase>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT t.id, t.occurred_at, t.amount, {REFUNDED}, t.cashback_set, t.cashback
             FROM transactions t
             WHERE t.account_id = ?1 AND t.kind = 'expense'
               AND t.refund_of IS NULL AND t.cashback_cycle IS NULL
             ORDER BY t.occurred_at, t.created_at, t.id"
        ))
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![card], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Paise>(2)?,
                r.get::<_, Paise>(3)?,
                r.get::<_, Option<Paise>>(4)?,
                r.get::<_, Paise>(5)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, at, amount, refunded, set, had)| {
            let day = NaiveDate::parse_from_str(&at[..10.min(at.len())], "%Y-%m-%d").ok()?;
            Some(Purchase { id, at, day, amount, refunded, set, had })
        })
        .collect())
}

/// Each purchase's share of its cycle's cashback, and what each cycle came
/// to, keyed by the day it closes. A share said by hand is taken as said and
/// still counts against the cap; the rest are the rate's, in the order they
/// were made, until the cap runs out.
fn allocate(
    purchases: &[Purchase],
    terms: &[CardTerm],
    live: Terms,
) -> (HashMap<String, Paise>, BTreeMap<NaiveDate, Paise>) {
    let mut shares = HashMap::new();
    let mut cycles: BTreeMap<NaiveDate, Paise> = BTreeMap::new();
    for p in purchases {
        let offer = offer_on(terms, &iso(p.day));
        if p.set.is_none() && offer.rate_e4 <= 0 {
            shares.insert(p.id.clone(), 0);
            continue;
        }
        let earned = cycles.entry(closes_on(terms, live, p.day)).or_insert(0);
        let back = match p.set {
            Some(said) => said.clamp(0, p.amount),
            None => {
                let base = (p.amount - p.refunded).max(0);
                // Rounded to the nearest paisa: rate_e4 is a percentage
                // scaled by 10^4, so the whole is 100 × 10^4.
                let full = (base * offer.rate_e4 + 500_000) / 1_000_000;
                if offer.cap > 0 {
                    full.min((offer.cap - *earned).max(0))
                } else {
                    full
                }
            }
        };
        *earned += back;
        shares.insert(p.id.clone(), back);
    }
    (shares, cycles)
}

/// What a card's cashback is filed under when it is written down by hand. A
/// category of either name, or one inside one, is read as a payout.
const PAYOUT_FILINGS: &str = "('rewards', 'cashback')";

/// Money landing on a card that might be its cashback paying out, written by
/// hand before the book worked it out: income that is neither a refund nor
/// the book's own credit.
struct Payout {
    id: String,
    day: NaiveDate,
    amount: Paise,
    /// Whether it is filed the way cashback is.
    filed: bool,
    /// Whether the book already counts it as a payout.
    flagged: bool,
}

fn payouts(conn: &Connection, card: &str) -> Result<Vec<Payout>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT t.id, t.occurred_at, t.amount, t.pays_cashback,
                    LOWER(COALESCE(c.name, '')) IN {PAYOUT_FILINGS}
                      OR LOWER(COALESCE(p.name, '')) IN {PAYOUT_FILINGS}
             FROM transactions t
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN categories p ON p.id = c.parent_id
             WHERE t.account_id = ?1 AND t.kind = 'income'
               AND t.refund_of IS NULL AND t.cashback_cycle IS NULL"
        ))
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![card], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Paise>(2)?,
                r.get::<_, i64>(3)? != 0,
                r.get::<_, bool>(4)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, at, amount, flagged, filed)| {
            let day = NaiveDate::parse_from_str(&at[..10.min(at.len())], "%Y-%m-%d").ok()?;
            Some(Payout { id, day, amount, filed, flagged })
        })
        .collect())
}

/// The terms the card itself carries, which is what `terms_on` falls back on.
fn live_terms(conn: &Connection, card: &str) -> Result<Terms> {
    conn.query_row(
        "SELECT credit_limit, statement_day, due_day FROM accounts WHERE id = ?1",
        params![card],
        |r| Ok(Terms { credit_limit: r.get(0)?, statement_day: r.get(1)?, due_day: r.get(2)? }),
    )
    .map_err(oops)
}

/// Brings every card's cashback into line with its purchases and its terms:
/// each purchase's share, and one credit for every cycle that has closed with
/// anything earned in it. Cheap enough to run after every change, and safe to
/// run any number of times — a book already in line is left untouched.
pub fn settle(conn: &Connection) -> Result<()> {
    let guard = if conn.is_autocommit() {
        Some(conn.unchecked_transaction().map_err(oops)?)
    } else {
        None
    };

    // Only a card's purchases earn anything. A posting moved off a card, or
    // turned into something that is not a purchase, gives its share back —
    // and a credit left on an account that is no longer a card goes.
    conn.execute(
        "UPDATE transactions SET cashback = 0
         WHERE cashback <> 0
           AND (kind <> 'expense' OR refund_of IS NOT NULL OR cashback_cycle IS NOT NULL
                OR account_id NOT IN (SELECT id FROM accounts WHERE kind = 'credit'))",
        [],
    )
    .map_err(oops)?;
    conn.execute(
        "DELETE FROM transactions
         WHERE cashback_cycle IS NOT NULL
           AND account_id NOT IN (SELECT id FROM accounts WHERE kind = 'credit')",
        [],
    )
    .map_err(oops)?;
    // And only money landing on a card can be its cashback paying out.
    conn.execute(
        "UPDATE transactions SET pays_cashback = 0
         WHERE pays_cashback <> 0
           AND (kind <> 'income' OR refund_of IS NOT NULL OR cashback_cycle IS NOT NULL
                OR account_id NOT IN (SELECT id FROM accounts WHERE kind = 'credit'))",
        [],
    )
    .map_err(oops)?;

    let cards: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM accounts WHERE kind = 'credit'")
            .map_err(oops)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(oops)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)?
    };
    for card in &cards {
        settle_card(conn, card)?;
    }

    if let Some(guard) = guard {
        guard.commit().map_err(oops)?;
    }
    Ok(())
}

fn settle_card(conn: &Connection, card: &str) -> Result<()> {
    let terms = card_terms(conn, card)?;
    let live = live_terms(conn, card)?;
    let bought = purchases(conn, card)?;
    let (shares, cycles) = allocate(&bought, &terms, live);

    for p in &bought {
        let back = shares.get(&p.id).copied().unwrap_or(0);
        if back != p.had {
            conn.execute(
                "UPDATE transactions SET cashback = ?2 WHERE id = ?1",
                params![p.id, back],
            )
            .map_err(oops)?;
        }
    }

    // One credit for each cycle that has closed with something earned in it,
    // on the day it closed. A cycle still open has not been credited yet:
    // what it has earned so far is pending, and the card still owes the lot.
    // Cashback already written down by hand — a Rewards row for each payout,
    // from before the book worked it out. While the offer covers it, it is
    // part of its cycle's credit arriving rather than income, so the credit
    // the book writes is only what those rows leave.
    let mut received: BTreeMap<NaiveDate, Paise> = BTreeMap::new();
    for row in payouts(conn, card)? {
        let covered = row.filed && offer_on(&terms, &iso(row.day)).rate_e4 > 0;
        if covered {
            *received.entry(closes_on(&terms, live, row.day)).or_insert(0) += row.amount;
        }
        if covered != row.flagged {
            conn.execute(
                "UPDATE transactions SET pays_cashback = ?2 WHERE id = ?1",
                params![row.id, covered as i64],
            )
            .map_err(oops)?;
        }
    }

    let today = today();
    let mut wanted: HashMap<String, Paise> = cycles
        .iter()
        .map(|(close, earned)| (*close, earned - received.get(close).copied().unwrap_or(0)))
        .filter(|(close, owed)| *owed > 0 && *close <= today)
        .map(|(close, owed)| (iso(close), owed))
        .collect();
    let standing: Vec<(String, String, Paise, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, cashback_cycle, amount, occurred_at, kind FROM transactions
                 WHERE account_id = ?1 AND cashback_cycle IS NOT NULL",
            )
            .map_err(oops)?;
        let rows = stmt
            .query_map(params![card], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(oops)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)?
    };
    for (id, cycle, amount, at, kind) in standing {
        match wanted.remove(&cycle) {
            Some(earned) => {
                let stamp = credited_at(&cycle);
                if amount != earned || at != stamp || kind != "income" {
                    conn.execute(
                        "UPDATE transactions
                         SET kind = 'income', amount = ?2, occurred_at = ?3,
                             to_account_id = NULL, refund_of = NULL, cashback_set = NULL
                         WHERE id = ?1",
                        params![id, earned, stamp],
                    )
                    .map_err(oops)?;
                }
            }
            // A cycle that no longer earned anything, or no longer exists
            // because the statement day moved, has nothing to credit.
            None => {
                conn.execute("DELETE FROM transactions WHERE id = ?1", params![id])
                    .map_err(oops)?;
            }
        }
    }
    for (cycle, earned) in wanted {
        conn.execute(
            "INSERT INTO transactions (id, kind, amount, account_id, to_account_id,
                                       category_id, merchant, note, occurred_at, created_at,
                                       cashback_cycle)
             VALUES (?1, 'income', ?2, ?3, NULL, NULL, ?4, NULL, ?5, ?6, ?7)",
            params![new_id(), earned, card, CREDIT_MERCHANT, credited_at(&cycle), now(), cycle],
        )
        .map_err(oops)?;
    }
    Ok(())
}

/// When a cycle's credit is dated: the last minute of the day it closed, so
/// it reads after everything the cycle bought.
fn credited_at(cycle: &str) -> String {
    format!("{cycle}T23:59")
}

/// What a purchase would earn, asked while it is being written — before it
/// is in the book, or while it is being changed. It is slotted into the
/// card's purchases where it would fall and the cycle shared out again, so
/// the answer is the one saving it will give.
pub fn quote(
    conn: &Connection,
    account: &str,
    occurred_at: &str,
    amount: Paise,
    id: Option<&str>,
) -> Result<CashbackQuote> {
    let none = CashbackQuote { cashback: 0, rate_e4: 0, cap: 0, earned: 0, credits_on: None };
    let kind: Option<String> = conn
        .query_row("SELECT kind FROM accounts WHERE id = ?1", params![account], |r| r.get(0))
        .ok();
    if kind.as_deref() != Some("credit") || amount <= 0 {
        return Ok(none);
    }
    let Ok(day) = NaiveDate::parse_from_str(&occurred_at[..10.min(occurred_at.len())], "%Y-%m-%d")
    else {
        return Ok(none);
    };
    let terms = card_terms(conn, account)?;
    let live = live_terms(conn, account)?;
    let offer = offer_on(&terms, &iso(day));

    let mut bought = purchases(conn, account)?;
    // The posting as it stands is replaced by the one being written: what it
    // has had refunded still stands against it, whatever else changes.
    let mut refunded = 0;
    if let Some(own) = id {
        if let Some(at) = bought.iter().position(|p| p.id == own) {
            refunded = bought.remove(at).refunded;
        }
    }
    let at = bought.partition_point(|p| p.at.as_str() <= occurred_at);
    bought.insert(
        at,
        Purchase {
            id: String::new(),
            at: occurred_at.to_string(),
            day,
            amount,
            refunded,
            set: None,
            had: 0,
        },
    );
    let (shares, cycles) = allocate(&bought, &terms, live);
    let close = closes_on(&terms, live, day);
    let cashback = shares.get("").copied().unwrap_or(0);
    Ok(CashbackQuote {
        cashback,
        rate_e4: offer.rate_e4,
        cap: offer.cap,
        earned: cycles.get(&close).copied().unwrap_or(0) - cashback,
        credits_on: Some(iso(close)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::save_card_term;
    use crate::db::{self, new_id, now};
    use chrono::Duration;

    fn book() -> Connection {
        let path = std::env::temp_dir().join(format!("midas-cashback-{}.sqlite3", new_id()));
        db::open(&path).unwrap()
    }

    fn card(conn: &Connection, statement_day: i64) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO accounts (id, name, kind, institution, opening_balance, color, icon,
                                   archived, sort_order, created_at, credit_limit,
                                   statement_day, due_day)
             VALUES (?1, 'Swiggy', 'credit', NULL, 0, '#f60', 'credit-card', 0, 0, ?2, 0, ?3, 0)",
            params![id, now(), statement_day],
        )
        .unwrap();
        id
    }

    fn buy(conn: &Connection, card: &str, amount: Paise, on: NaiveDate, set: Option<Paise>) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO transactions (id, kind, amount, account_id, merchant, occurred_at,
                                       created_at, cashback_set)
             VALUES (?1, 'expense', ?2, ?3, 'Swiggy', ?4, ?5, ?6)",
            params![id, amount, card, format!("{on}T12:00"), now(), set],
        )
        .unwrap();
        id
    }

    fn back(conn: &Connection, id: &str) -> Paise {
        conn.query_row("SELECT cashback FROM transactions WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap()
    }

    fn credits(conn: &Connection, card: &str) -> Vec<(String, Paise)> {
        let mut stmt = conn
            .prepare(
                "SELECT cashback_cycle, amount FROM transactions
                 WHERE account_id = ?1 AND cashback_cycle IS NOT NULL ORDER BY cashback_cycle",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![card], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    fn offer(conn: &Connection, card: &str, from: NaiveDate, rate_e4: i64, cap: Paise) {
        save_card_term(conn, card, &iso(from), None, None, None, Some(rate_e4), Some(cap), None)
            .unwrap();
    }

    #[test]
    fn a_purchase_earns_the_rate_and_counts_for_the_rest() {
        let conn = book();
        let card = card(&conn, 0);
        let day = today();
        offer(&conn, &card, day - Duration::days(400), 100_000, 0);
        let bill = buy(&conn, &card, 1_000_00, day, None);
        settle(&conn).unwrap();
        assert_eq!(back(&conn, &bill), 100_00);

        // The total counts what it cost, not what was paid.
        let spent: Paise = conn
            .query_row(
                &format!(
                    "SELECT SUM(t.amount - {}) FROM transactions t WHERE t.id = ?1",
                    db::CASHBACK
                ),
                params![bill],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(spent, 900_00);
    }

    #[test]
    fn the_cap_runs_out_on_the_last_purchases_of_a_cycle() {
        let conn = book();
        let card = card(&conn, 0);
        // A month well in the past, so its cycle has closed and been credited.
        let first = NaiveDate::from_ymd_opt(2025, 3, 1).unwrap();
        offer(&conn, &card, first, 100_000, 1_500_00);
        let a = buy(&conn, &card, 10_000_00, first + Duration::days(2), None);
        let b = buy(&conn, &card, 8_000_00, first + Duration::days(5), None);
        let c = buy(&conn, &card, 2_000_00, first + Duration::days(9), None);
        settle(&conn).unwrap();
        assert_eq!(back(&conn, &a), 1_000_00);
        assert_eq!(back(&conn, &b), 500_00);
        assert_eq!(back(&conn, &c), 0);
        assert_eq!(credits(&conn, &card), vec![("2025-03-31".to_string(), 1_500_00)]);

        // A purchase back-dated to before the others takes its share first.
        let early = buy(&conn, &card, 1_000_00, first, None);
        settle(&conn).unwrap();
        assert_eq!(back(&conn, &early), 100_00);
        assert_eq!(back(&conn, &b), 400_00);
        assert_eq!(credits(&conn, &card), vec![("2025-03-31".to_string(), 1_500_00)]);
    }

    #[test]
    fn nothing_earns_before_the_offer_began_or_once_it_stops() {
        let conn = book();
        let card = card(&conn, 0);
        let start = NaiveDate::from_ymd_opt(2025, 6, 10).unwrap();
        let before = buy(&conn, &card, 500_00, start - Duration::days(3), None);
        offer(&conn, &card, start, 100_000, 0);
        let during = buy(&conn, &card, 500_00, start, None);
        offer(&conn, &card, start + Duration::days(30), 0, 0);
        let after = buy(&conn, &card, 500_00, start + Duration::days(31), None);
        settle(&conn).unwrap();
        assert_eq!((back(&conn, &before), back(&conn, &during), back(&conn, &after)), (0, 50_00, 0));
    }

    #[test]
    fn a_figure_said_by_hand_stands_and_counts_against_the_cap() {
        let conn = book();
        let card = card(&conn, 0);
        let first = NaiveDate::from_ymd_opt(2025, 4, 1).unwrap();
        offer(&conn, &card, first, 100_000, 1_000_00);
        let rent = buy(&conn, &card, 20_000_00, first, Some(0));
        let said = buy(&conn, &card, 5_000_00, first + Duration::days(1), Some(800_00));
        let rest = buy(&conn, &card, 5_000_00, first + Duration::days(2), None);
        settle(&conn).unwrap();
        assert_eq!((back(&conn, &rent), back(&conn, &said), back(&conn, &rest)), (0, 800_00, 200_00));
    }

    #[test]
    fn cycles_follow_the_statement_day_and_only_closed_ones_are_credited() {
        let conn = book();
        let card = card(&conn, 15);
        let day = today();
        offer(&conn, &card, day - Duration::days(120), 100_000, 0);
        let old = buy(&conn, &card, 1_000_00, day - Duration::days(70), None);
        let now = buy(&conn, &card, 2_000_00, day, None);
        settle(&conn).unwrap();
        let closed = closes_on(&card_terms(&conn, &card).unwrap(), live_terms(&conn, &card).unwrap(), day - Duration::days(70));
        assert_eq!(closed.day(), 15);
        let open_close = closes_on(&card_terms(&conn, &card).unwrap(), live_terms(&conn, &card).unwrap(), day);
        let expect: Vec<(String, Paise)> = if open_close <= day {
            // Run on the statement day itself: today's cycle has closed too.
            vec![(iso(closed), 100_00), (iso(open_close), 200_00)]
        } else {
            vec![(iso(closed), 100_00)]
        };
        assert_eq!(credits(&conn, &card), expect);
        assert_eq!((back(&conn, &old), back(&conn, &now)), (100_00, 200_00));

        // The credit is no income: the totals leave it out.
        let income: Paise = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
                     WHERE t.kind = 'income' AND {}",
                    db::NOT_A_REFUND
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(income, 0);
    }

    #[test]
    fn a_refund_takes_its_share_of_the_cashback_back() {
        let conn = book();
        let card = card(&conn, 0);
        let first = NaiveDate::from_ymd_opt(2025, 5, 1).unwrap();
        offer(&conn, &card, first, 100_000, 0);
        let bill = buy(&conn, &card, 1_000_00, first, None);
        conn.execute(
            "INSERT INTO transactions (id, kind, amount, account_id, merchant, occurred_at,
                                       created_at, refund_of)
             VALUES (?1, 'income', 40000, ?2, 'Swiggy', '2025-05-03T10:00', ?3, ?4)",
            params![new_id(), card, now(), bill],
        )
        .unwrap();
        settle(&conn).unwrap();
        assert_eq!(back(&conn, &bill), 60_00);
        assert_eq!(credits(&conn, &card), vec![("2025-05-31".to_string(), 60_00)]);
    }

    #[test]
    fn a_quote_is_what_saving_would_give() {
        let conn = book();
        let card = card(&conn, 0);
        let first = NaiveDate::from_ymd_opt(2025, 7, 1).unwrap();
        offer(&conn, &card, first, 100_000, 1_500_00);
        buy(&conn, &card, 14_000_00, first + Duration::days(1), None);
        settle(&conn).unwrap();
        let q = quote(&conn, &card, "2025-07-20T10:00", 5_000_00, None).unwrap();
        assert_eq!((q.cashback, q.earned, q.cap), (100_00, 1_400_00, 1_500_00));
        assert_eq!(q.credits_on.as_deref(), Some("2025-07-31"));
    }

    fn payout(conn: &Connection, card: &str, filed: &str, amount: Paise, on: NaiveDate) -> String {
        let category = new_id();
        conn.execute(
            "INSERT INTO categories (id, kind, name, icon, color) VALUES (?1, 'income', ?2, 'award', '#0a0')",
            params![category, filed],
        )
        .unwrap();
        let id = new_id();
        conn.execute(
            "INSERT INTO transactions (id, kind, amount, account_id, category_id, merchant,
                                       occurred_at, created_at)
             VALUES (?1, 'income', ?2, ?3, ?4, 'Swiggy', ?5, ?6)",
            params![id, amount, card, category, format!("{on}T12:00"), now()],
        )
        .unwrap();
        id
    }

    fn pays(conn: &Connection, id: &str) -> bool {
        conn.query_row("SELECT pays_cashback FROM transactions WHERE id = ?1", params![id], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
            != 0
    }

    #[test]
    fn rewards_written_by_hand_are_the_credit_arriving_not_income() {
        let conn = book();
        let card = card(&conn, 0);
        let first = NaiveDate::from_ymd_opt(2025, 8, 1).unwrap();
        // Written down before the offer was: income like any other.
        let before = payout(&conn, &card, "Rewards", 30_00, first - Duration::days(5));
        offer(&conn, &card, first, 100_000, 0);
        buy(&conn, &card, 1_000_00, first, None);
        buy(&conn, &card, 2_000_00, first + Duration::days(3), None);
        let paid = payout(&conn, &card, "Rewards", 100_00, first + Duration::days(2));
        let gift = payout(&conn, &card, "Salary", 50_00, first + Duration::days(4));
        settle(&conn).unwrap();

        assert!(pays(&conn, &paid));
        assert!(!pays(&conn, &before));
        assert!(!pays(&conn, &gift));
        // ₹300 earned, ₹100 of it already written down: the book tops up ₹200.
        assert_eq!(credits(&conn, &card), vec![("2025-08-31".to_string(), 200_00)]);

        let income: Paise = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
                     WHERE t.kind = 'income' AND {}",
                    db::NOT_A_REFUND
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(income, 30_00 + 50_00);

        // Taking the offer away hands the row back to income.
        conn.execute("DELETE FROM card_terms WHERE account_id = ?1", params![card]).unwrap();
        settle(&conn).unwrap();
        assert!(!pays(&conn, &paid));
        assert_eq!(credits(&conn, &card), vec![]);
    }

    #[test]
    fn a_card_that_stops_being_one_loses_its_credits() {
        let conn = book();
        let card = card(&conn, 0);
        let first = NaiveDate::from_ymd_opt(2025, 2, 1).unwrap();
        offer(&conn, &card, first, 100_000, 0);
        let bill = buy(&conn, &card, 1_000_00, first, None);
        settle(&conn).unwrap();
        assert_eq!(credits(&conn, &card).len(), 1);
        conn.execute("UPDATE accounts SET kind = 'bank' WHERE id = ?1", params![card]).unwrap();
        settle(&conn).unwrap();
        assert_eq!(credits(&conn, &card).len(), 0);
        assert_eq!(back(&conn, &bill), 0);
    }
}
