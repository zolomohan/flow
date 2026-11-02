//! Credit cards: what is owed, what has been billed, and what has not.
//!
//! A card is the one account whose month is not the calendar's. It closes on
//! a day of its own, bills what it closed on, and wants paying by another day
//! entirely — so "August" answers almost nothing you would want to know about
//! a card, and the tab is built around the cycle instead.
//!
//! Two arithmetics live here on purpose, and they are not the same:
//!
//! * **The cycle** is the bank's. Charges less credits, in the cycle each one
//!   landed in, tying exactly to the balance the ledger holds — because that
//!   is what a statement is and what a payment has to match.
//! * **The window** is the book's. Spending over the months on screen, with
//!   refunds netted off the posting they undo, exactly as the dashboard and
//!   every other total in Midas counts it.
//!
//! Nothing here is stored. The cycle is derived from two days of the month
//! kept on the account, and everything else is read off the ledger, so a
//! posting corrected anywhere fixes the card for free.

use chrono::{Datelike, Duration, NaiveDate, Utc};
use rusqlite::{params, Connection};

use crate::cashback;
use crate::db::{self, month_bounds, oops, shift_month, Result, CASHBACK, NOT_A_REFUND, REFUNDED};
use crate::models::*;

/// How many closed cycles the card carries with it, before the open one.
const CYCLES_BACK: i64 = 12;

pub(crate) fn today() -> NaiveDate {
    Utc::now().date_naive()
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|first| first.pred_opt())
        .map(|last| last.day())
        .unwrap_or(28)
}

/// The day of a given month a cycle lands on. A card that closes on the 31st
/// closes on the 28th of February: the day it wants does not exist, and the
/// end of the month is the only thing it can mean.
fn day_in(year: i32, month: u32, day: i64) -> NaiveDate {
    let clamped = (day as u32).clamp(1, days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, clamped).unwrap_or_else(|| {
        NaiveDate::from_ymd_opt(year, month, 1).expect("a first of the month always exists")
    })
}

/// The most recent cycle day on or before `on`.
fn last_on_or_before(on: NaiveDate, day: i64) -> NaiveDate {
    let this = day_in(on.year(), on.month(), day);
    if this <= on {
        return this;
    }
    let (y, m) = if on.month() == 1 { (on.year() - 1, 12) } else { (on.year(), on.month() - 1) };
    day_in(y, m, day)
}

/// The first cycle day strictly after `on` — which is how a due date is
/// found from a statement: a card billed on the 2nd and due on the 22nd is
/// due that same month, and one due on the 1st is due the month after.
fn first_after(on: NaiveDate, day: i64) -> NaiveDate {
    let this = day_in(on.year(), on.month(), day);
    if this > on {
        return this;
    }
    let (y, m) = if on.month() == 12 { (on.year() + 1, 1) } else { (on.year(), on.month() + 1) };
    day_in(y, m, day)
}

pub(crate) fn iso(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// One day's movement on a card, as the bank would see it.
#[derive(Default, Clone, Copy)]
struct Movement {
    /// What was put on the card: spending, and anything transferred off it.
    charged: Paise,
    /// What came back onto it: refunds, cashback, a reversed charge.
    credited: Paise,
    /// What was paid off it.
    paid: Paise,
    /// What the day's purchases earned back.
    earned: Paise,
}

/// Every day this card moved, oldest first. One query answers the whole tab:
/// the cycles, the statement, and what is still unbilled all fall out of it.
fn movements(conn: &Connection, card: &str) -> Result<Vec<(NaiveDate, Movement)>> {
    let mut stmt = conn
        .prepare(
            "SELECT substr(t.occurred_at, 1, 10) AS day,
                    COALESCE(SUM(CASE WHEN t.account_id = ?1 AND t.kind IN ('expense', 'transfer')
                                      THEN t.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.account_id = ?1 AND t.kind = 'income'
                                      THEN t.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.to_account_id = ?1 AND t.kind = 'transfer'
                                      THEN t.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.account_id = ?1 AND t.kind = 'expense'
                                      THEN t.cashback ELSE 0 END), 0)
             FROM transactions t
             WHERE t.account_id = ?1 OR t.to_account_id = ?1
             GROUP BY day ORDER BY day",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![card], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Movement {
                    charged: r.get(1)?,
                    credited: r.get(2)?,
                    paid: r.get(3)?,
                    earned: r.get(4)?,
                },
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows
        .into_iter()
        .filter_map(|(day, m)| NaiveDate::parse_from_str(&day, "%Y-%m-%d").ok().map(|d| (d, m)))
        .collect())
}

/// Everything on the card between two days, both ends included.
fn between(days: &[(NaiveDate, Movement)], from: NaiveDate, to: NaiveDate) -> Movement {
    days.iter()
        .filter(|(day, _)| *day >= from && *day <= to)
        .fold(Movement::default(), |mut sum, (_, m)| {
            sum.charged += m.charged;
            sum.credited += m.credited;
            sum.paid += m.paid;
            sum.earned += m.earned;
            sum
        })
}

/// What the card was spent on over a window, the book's way: expenses only,
/// less whatever has been refunded against them and whatever the card gave
/// back on them. A payment is not spending and neither is a refund, so
/// neither is in here.
fn netted_spend(conn: &Connection, card: &str, from: &str, to: &str) -> Result<(Paise, i64)> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(t.amount - {REFUNDED} - {CASHBACK}), 0), COUNT(*)
             FROM transactions t
             WHERE t.account_id = ?1 AND t.kind = 'expense' AND {NOT_A_REFUND}
               AND t.occurred_at >= ?2 AND t.occurred_at <= ?3"
        ),
        params![card, from, to],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(oops)
}

/// Who the card was used with over the window, biggest first, refunds netted
/// off exactly as the dashboard nets them.
fn top_merchants(conn: &Connection, card: &str, from: &str, to: &str) -> Result<Vec<MerchantSlice>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT t.merchant, SUM(t.amount - {REFUNDED} - {CASHBACK}), COUNT(*)
             FROM transactions t
             WHERE t.account_id = ?1 AND t.kind = 'expense' AND {NOT_A_REFUND}
               AND t.merchant <> '' AND t.occurred_at >= ?2 AND t.occurred_at <= ?3
             GROUP BY LOWER(t.merchant)
             HAVING SUM(t.amount - {REFUNDED} - {CASHBACK}) > 0
             ORDER BY SUM(t.amount - {REFUNDED} - {CASHBACK}) DESC LIMIT 5"
        ))
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![card, from, to], |r| {
            Ok(MerchantSlice { merchant: r.get(0)?, total: r.get(1)?, count: r.get(2)? })
        })
        .map_err(oops)?;
    rows.collect::<rusqlite::Result<_>>().map_err(oops)
}

/// The last time anything was put on the card.
fn last_used(conn: &Connection, card: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT MAX(occurred_at) FROM transactions
         WHERE account_id = ?1 AND kind = 'expense'",
        params![card],
        |r| r.get::<_, Option<String>>(0),
    )
    .map_err(oops)
}

/// The day the statement closes for a cycle that opened on `from`.
///
/// Forwards rather than backwards, because a statement day is only knowable
/// forwards: a bank that moves the closing day from the 5th to the 20th on
/// the 24th of May does not go back and cut a statement on the 20th of May —
/// it cuts the next one on the 20th of June, and the cycle across the change
/// is a long one. Walking back from today would put that statement a month
/// early and a fortnight of charges on the wrong bill.
///
/// `None` where the card keeps no cycle from here on, which is the one case
/// with no answer to give.
pub(crate) fn close_after(from: NaiveDate, terms: &[CardTerm], live: Terms) -> Option<NaiveDate> {
    let day_on = |d: NaiveDate| terms_on(terms, &iso(d), live).statement_day;
    let mut open = from;
    let mut day = day_on(open);
    if day == 0 {
        // No cycle kept when this one would have opened: the card's cycles
        // start at the change that first gives it one.
        let next = terms
            .iter()
            .filter(|t| t.statement_day.unwrap_or(0) > 0 && t.effective_on > iso(open))
            .map(|t| t.effective_on.as_str())
            .min()?;
        open = NaiveDate::parse_from_str(next, "%Y-%m-%d").ok()?;
        day = day_on(open);
        if day == 0 {
            return None;
        }
    }
    let mut close = first_after(open - Duration::days(1), day);
    // A day moved inside the cycle moves the statement with it: the close is
    // then the first one on the new day, counted from the change.
    loop {
        let moved = terms.iter().find(|t| {
            t.statement_day.is_some_and(|d| d != day)
                && t.effective_on > iso(open)
                && t.effective_on <= iso(close)
        });
        let Some(change) = moved else { break };
        day = change.statement_day.unwrap_or(day);
        if day == 0 {
            return None;
        }
        open = NaiveDate::parse_from_str(&change.effective_on, "%Y-%m-%d").ok()?;
        close = first_after(open - Duration::days(1), day);
    }
    Some(close)
}

/// The cycles a card has been through, oldest first, with the one still
/// running last. Empty when the card keeps no cycle: there is nothing to
/// divide the months into, and inventing a division would be a lie.
///
/// Built forwards from well before the dozen that are kept, so a statement
/// day the bank moved splits the cycles where it actually moved.
fn cycles_of(
    days: &[(NaiveDate, Movement)],
    terms: &[CardTerm],
    live: Terms,
    on: NaiveDate,
) -> Vec<CardCycle> {
    if terms_on(terms, &iso(on), live).statement_day == 0 {
        return Vec::new();
    }
    // Far enough back that the dozen kept are all properly bounded — the
    // first cycle of the walk opens on an arbitrary day and is dropped.
    let mut from = on - Duration::days(31 * (CYCLES_BACK + 3));
    let mut runs: Vec<(NaiveDate, NaiveDate)> = Vec::new();
    for _ in 0..(CYCLES_BACK + 8) {
        let Some(close) = close_after(from, terms, live) else { break };
        // A cycle that opened before the card kept one starts where the
        // statement it ends with does.
        let opened = from.min(close);
        runs.push((opened, close));
        if close > on {
            break;
        }
        from = close + Duration::days(1);
    }
    // The one still running is the last, and the dozen before it the rest.
    let keep = (CYCLES_BACK + 1) as usize;
    let cut = runs.len().saturating_sub(keep);

    runs[cut..]
        .iter()
        .map(|(opened, close)| {
            let m = between(days, *opened, *close);
            CardCycle {
                from: iso(*opened),
                closed_on: iso(*close),
                spend: m.charged - m.credited,
                paid: m.paid,
                cashback: m.earned,
                open: *close > on,
            }
        })
        .collect()
}

/// One card, whole, read over `start`..`end` — and, for the comparison the
/// tab makes, over `prev`, the window of the same shape immediately before it.
/// A window with nothing before it (all of time) has no comparison to make.
fn stat_of(
    conn: &Connection,
    card: &Account,
    start: &str,
    end: &str,
    prev: Option<(&str, &str)>,
) -> Result<CardStat> {
    let now = today();
    let days = movements(conn, &card.id)?;

    // The card's terms are the changes recorded against it; what the account
    // row carries is a copy kept in step for the screens that read it in
    // passing. Everything here reads them from the changes, so a card is
    // never read on terms its own history disagrees with.
    let terms = card_terms(conn, &card.id)?;
    let live = Terms {
        credit_limit: card.credit_limit,
        statement_day: card.statement_day,
        due_day: card.due_day,
    };
    let standing = terms_on(&terms, &iso(now), live);
    // …and as they stood when the window ended, so an old cycle is read
    // against the card as it was then rather than as it is now.
    let window_credit_limit = terms_on(&terms, &end[..10.min(end.len())], live).credit_limit;

    // What is owed, and what is left of the limit. A card sitting in credit
    // owes nothing and has its whole limit — plus the credit — to spend.
    let owed = (-card.balance).max(0);
    let available = if standing.credit_limit > 0 {
        (standing.credit_limit - owed).max(0)
    } else {
        0
    };

    // The statement, worked backwards from the balance. Everything that has
    // happened since it closed is taken back off, which leaves what it said.
    let (statement_on, due_on, statement_total, billed, unbilled, paid_since) =
        if standing.statement_day > 0 {
            let closed = last_on_or_before(now, standing.statement_day);
            let since = between(&days, closed + Duration::days(1), now);
            let statement = owed + since.credited - since.charged + since.paid;
            // Payments since the statement pay the bill off first, which is
            // what a bank does with them and what anybody paying one means.
            let still_due = (statement - since.paid).clamp(0, owed);
            let due = if standing.due_day > 0 {
                Some(iso(first_after(closed, standing.due_day)))
            } else {
                None
            };
            (
                Some(iso(closed)),
                due,
                statement.max(0),
                still_due,
                owed - still_due,
                since.paid,
            )
        } else {
            // No cycle kept: all of it is simply owed, and none of it can be
            // called billed or unbilled without making something up.
            (None, None, 0, 0, owed, 0)
        };

    // What the card gives back. Earned on every purchase and credited a
    // cycle at a time, so what has been earned and not yet credited is the
    // cycle still open — and it lands the day that cycle closes.
    let (earned_ever, credited_ever, earned_in_window): (Paise, Paise, Paise) = conn
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN kind = 'expense' THEN cashback ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN cashback_cycle IS NOT NULL OR pays_cashback = 1
                                      THEN amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'expense'
                                       AND occurred_at >= ?2 AND occurred_at <= ?3
                                      THEN cashback ELSE 0 END), 0)
             FROM transactions WHERE account_id = ?1",
            params![card.id, start, end],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(oops)?;
    let cashback_pending = (earned_ever - credited_ever).max(0);
    let cashback_credits_on = (cashback_pending > 0 || card.cashback_rate_e4 > 0)
        .then(|| iso(cashback::closes_on(&terms, live, now)));

    let (spend, charges) = netted_spend(conn, &card.id, start, end)?;
    let prev_spend = match prev {
        Some((pstart, pend)) => netted_spend(conn, &card.id, pstart, pend)?.0,
        None => 0,
    };

    let window = between(
        &days,
        NaiveDate::parse_from_str(&start[..10], "%Y-%m-%d").unwrap_or(now),
        NaiveDate::parse_from_str(&end[..10], "%Y-%m-%d").unwrap_or(now),
    );

    Ok(CardStat {
        id: card.id.clone(),
        name: card.name.clone(),
        institution: card.institution.clone(),
        color: card.color.clone(),
        icon: card.icon.clone(),
        outstanding: owed,
        balance: card.balance,
        credit_limit: standing.credit_limit,
        available,
        window_credit_limit,
        statement_day: standing.statement_day,
        due_day: standing.due_day,
        statement_on,
        due_on,
        statement_total,
        billed,
        unbilled,
        paid_since,
        spend,
        prev_spend,
        paid: window.paid,
        charges,
        last_used: last_used(conn, &card.id)?,
        cashback_rate_e4: card.cashback_rate_e4,
        cashback_cap: card.cashback_cap,
        cashback_pending,
        cashback_credits_on,
        cashback: earned_in_window,
        cashback_total: credited_ever,
        cycles: cycles_of(&days, &terms, live, now),
        top_categories: db::spend_by_category_in(conn, start, end, Some(&card.id))?,
        top_merchants: top_merchants(conn, &card.id, start, end)?,
    })
}

/// Every card together, month by month. Spending is the book's arithmetic —
/// refunds netted off what they undo — and payments are what landed on the
/// cards, so the two lines answer "what did they cost" and "what did I clear".
fn monthly_flow(conn: &Connection, cards: &[String], from: &str, to: &str) -> Result<Vec<FlowPoint>> {
    if cards.is_empty() {
        return Ok(Vec::new());
    }
    let holes = std::iter::repeat("?").take(cards.len()).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT substr(t.occurred_at, 1, 7) AS m,
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND {NOT_A_REFUND}
                                   AND t.account_id IN ({holes})
                                  THEN t.amount - {REFUNDED} - {CASHBACK} ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'transfer' AND t.to_account_id IN ({holes})
                                  THEN t.amount ELSE 0 END), 0)
         FROM transactions t
         WHERE (t.account_id IN ({holes}) OR t.to_account_id IN ({holes}))
           AND t.occurred_at >= ? AND t.occurred_at <= ?
         GROUP BY m"
    );
    let mut args: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for _ in 0..4 {
        for id in cards {
            args.push(id);
        }
    }
    args.push(&from);
    args.push(&to);

    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, Paise>(1)?, r.get::<_, Paise>(2)?)))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()
        .map_err(oops)?;
    Ok(rows
        .into_iter()
        .map(|(m, (spend, paid))| FlowPoint { bucket: m, income: paid, expense: spend })
        .collect())
}

/// Every change of terms recorded against a card, oldest first.
pub fn card_terms(conn: &Connection, account: &str) -> Result<Vec<CardTerm>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, effective_on, credit_limit, statement_day, due_day, note,
                    cashback_rate_e4, cashback_cap
             FROM card_terms WHERE account_id = ?1 ORDER BY effective_on",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![account], |r| {
            Ok(CardTerm {
                id: r.get(0)?,
                account_id: r.get(1)?,
                effective_on: r.get(2)?,
                credit_limit: r.get(3)?,
                statement_day: r.get(4)?,
                due_day: r.get(5)?,
                note: r.get(6)?,
                cashback_rate_e4: r.get(7)?,
                cashback_cap: r.get(8)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

/// The terms in force on a day: every change up to it folded forward, one
/// term at a time, since a change that only moved the limit says nothing
/// about the statement day and must not be read as having cleared it.
///
/// A term nothing was recorded for before that day falls back to the
/// earliest figure on file — the book only knows what it became later, and
/// that is still a better answer than today's, which is the one that made
/// the old cycle read wrong in the first place. A card with nothing recorded
/// at all is simply on the terms it is on now.
pub(crate) fn terms_on(rows: &[CardTerm], day: &str, live: Terms) -> Terms {
    let mut terms = Terms { credit_limit: 0, statement_day: 0, due_day: 0 };
    let mut known = (false, false, false);
    for row in rows.iter().filter(|r| r.effective_on.as_str() <= day) {
        if let Some(limit) = row.credit_limit {
            terms.credit_limit = limit;
            known.0 = true;
        }
        if let Some(day) = row.statement_day {
            terms.statement_day = day;
            known.1 = true;
        }
        if let Some(day) = row.due_day {
            terms.due_day = day;
            known.2 = true;
        }
    }
    // Whatever the changes up to that day never mentioned: the earliest the
    // book has, and failing that the card as it stands.
    //
    // Only changes that have actually happened can stand in like that. One
    // dated into next year says nothing about any day before it — least of
    // all about today, when the card is plainly not on those terms yet.
    let now = iso(today());
    let started = |r: &&CardTerm| r.effective_on <= now;
    if !known.0 {
        terms.credit_limit = rows
            .iter()
            .filter(started)
            .find_map(|r| r.credit_limit)
            .unwrap_or(live.credit_limit);
    }
    if !known.1 {
        terms.statement_day = rows
            .iter()
            .filter(started)
            .find_map(|r| r.statement_day)
            .unwrap_or(live.statement_day);
    }
    if !known.2 {
        terms.due_day = rows
            .iter()
            .filter(started)
            .find_map(|r| r.due_day)
            .unwrap_or(live.due_day);
    }
    terms
}

/// Records what a card's terms became on a day. A change dated today or
/// earlier moves the card itself too, so the account never disagrees with
/// its own history.
///
/// The cashback a card gives is a term like the rest: a rate, as a
/// percentage scaled by 10^4, and the most a cycle earns. Zero on the rate
/// is a card that stopped giving any back, and zero on the cap is no cap.
#[allow(clippy::too_many_arguments)]
pub fn save_card_term(
    conn: &Connection,
    account: &str,
    effective_on: &str,
    credit_limit: Option<Paise>,
    statement_day: Option<i64>,
    due_day: Option<i64>,
    cashback_rate_e4: Option<i64>,
    cashback_cap: Option<Paise>,
    note: Option<&str>,
) -> Result<CardTerm> {
    if credit_limit.is_none()
        && statement_day.is_none()
        && due_day.is_none()
        && cashback_rate_e4.is_none()
        && cashback_cap.is_none()
    {
        return Err(oops("a change has to change something"));
    }
    if cashback_rate_e4.is_some_and(|r| !(0..=1_000_000).contains(&r)) {
        return Err(oops("cashback is a share of what was paid, so 0–100%"));
    }
    if cashback_cap.is_some_and(|c| c < 0) {
        return Err(oops("a cap on cashback can't be below nothing"));
    }
    conn.execute(
        "INSERT INTO card_terms
             (id, account_id, effective_on, credit_limit, statement_day, due_day, note, created_at,
              cashback_rate_e4, cashback_cap)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(account_id, effective_on)
         DO UPDATE SET credit_limit = excluded.credit_limit,
                       statement_day = excluded.statement_day,
                       due_day = excluded.due_day,
                       note = excluded.note,
                       cashback_rate_e4 = excluded.cashback_rate_e4,
                       cashback_cap = excluded.cashback_cap",
        params![
            db::new_id(),
            account,
            effective_on,
            credit_limit,
            statement_day,
            due_day,
            note,
            db::now(),
            cashback_rate_e4,
            cashback_cap
        ],
    )
    .map_err(oops)?;
    sync_live_terms(conn, account)?;
    card_terms(conn, account)?
        .into_iter()
        .find(|t| t.effective_on == effective_on)
        .ok_or_else(|| oops("the change was not saved"))
}

/// Takes a recorded change back out. Whatever is left standing on today is
/// what the card is on, exactly as after a change is saved.
pub fn delete_card_term(conn: &Connection, id: &str) -> Result<()> {
    let account: Option<String> = conn
        .query_row("SELECT account_id FROM card_terms WHERE id = ?1", params![id], |r| r.get(0))
        .ok();
    conn.execute("DELETE FROM card_terms WHERE id = ?1", params![id])
        .map_err(oops)?;
    if let Some(account) = account {
        sync_live_terms(conn, &account)?;
    }
    Ok(())
}

/// Moves the account onto the terms standing today. Changes dated ahead are
/// terms that have not started yet, and the card is not on them.
fn sync_live_terms(conn: &Connection, account: &str) -> Result<()> {
    let rows = card_terms(conn, account)?;
    if rows.is_empty() {
        return Ok(());
    }
    let live = live_terms(conn, account)?;
    let now = terms_on(&rows, &iso(today()), live);
    conn.execute(
        "UPDATE accounts SET credit_limit = ?2, statement_day = ?3, due_day = ?4 WHERE id = ?1",
        params![account, now.credit_limit, now.statement_day, now.due_day],
    )
    .map_err(oops)?;
    Ok(())
}

/// The terms as the account itself has them — where a card with nothing
/// recorded stands, and the floor under everything above.
fn live_terms(conn: &Connection, account: &str) -> Result<Terms> {
    conn.query_row(
        "SELECT credit_limit, statement_day, due_day FROM accounts WHERE id = ?1",
        params![account],
        |r| {
            Ok(Terms {
                credit_limit: r.get(0)?,
                statement_day: r.get(1)?,
                due_day: r.get(2)?,
            })
        },
    )
    .map_err(oops)
}

/// The window a card view is read over, and the one before it that the tab
/// compares against.
struct Window {
    start: String,
    end: String,
    /// None where nothing came before — a window that reaches back to the
    /// start of the book has no earlier self to be measured against.
    prev: Option<(String, String)>,
}

/// The days a card view covers. Usually that is the months on the tab's own
/// strip; a card read over its billing cycle, or over the whole book, says so
/// in days instead, because neither is a run of calendar months.
///
/// The comparison follows the window it is made about: whole months back a
/// whole month, and an arbitrary run of days back the same number of days.
fn window_of(month: &str, span: i32, from: Option<&str>, to: Option<&str>) -> Result<Window> {
    let day_end = |d: NaiveDate| format!("{}T23:59:59", d.format("%Y-%m-%d"));

    let day = |d: &str| {
        NaiveDate::parse_from_str(&d[..10.min(d.len())], "%Y-%m-%d")
            .map_err(|_| oops(format!("{d} is not a day")))
    };

    if from.is_none() && to.is_none() {
        // The months on screen, and the same number of months before them, so
        // a year is compared against a year rather than a single month.
        let (start, _) = month_bounds(&shift_month(month, -(span - 1))?)?;
        let (_, end) = month_bounds(month)?;
        let prev_month = shift_month(month, -span)?;
        let (pstart, _) = month_bounds(&shift_month(&prev_month, -(span - 1))?)?;
        let (_, pend) = month_bounds(&prev_month)?;
        return Ok(Window {
            start: start.format("%Y-%m-%d").to_string(),
            end: day_end(end),
            prev: Some((pstart.format("%Y-%m-%d").to_string(), day_end(pend))),
        });
    }

    let end = match to {
        Some(t) => day(t)?,
        None => today(),
    };
    // No opening day is all of time up to `to`: everything the card has ever
    // done, which has nothing before it to be compared against.
    let Some(from) = from else {
        return Ok(Window {
            start: "0001-01-01".to_string(),
            end: day_end(end),
            prev: None,
        });
    };
    let start = day(from)?;
    // The run of days immediately before this one, the same length: the cycle
    // before this cycle, near enough, however the bank's dates fall.
    let days = (end - start).num_days().max(0);
    let prev_end = start - Duration::days(1);
    let prev_start = prev_end - Duration::days(days);
    Ok(Window {
        start: start.format("%Y-%m-%d").to_string(),
        end: day_end(end),
        prev: Some((prev_start.format("%Y-%m-%d").to_string(), day_end(prev_end))),
    })
}

/// Every card in the book, in the order the accounts screen keeps them.
/// Archived cards are left out: a card you have closed is history, and the
/// Accounts screen is where history is kept.
pub fn cards_overview(
    conn: &Connection,
    month: &str,
    span: u32,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<CardsOverview> {
    let span = span.max(1) as i32;
    let window = window_of(month, span, from, to)?;
    let (start_s, end_s) = (window.start.clone(), window.end.clone());
    let prev = window
        .prev
        .as_ref()
        .map(|(a, b)| (a.as_str(), b.as_str()));

    let accounts = db::list_accounts(conn)?;
    let mut cards = Vec::new();
    for card in accounts.iter().filter(|a| a.kind == "credit" && !a.archived) {
        cards.push(stat_of(conn, card, &start_s, &end_s, prev)?);
    }

    // A year of months, or the window when it reaches back further — and
    // every month in it, including the ones nothing happened in, so the
    // chart has no gaps where a quiet month was.
    let months_back = span.max(12);
    let first = shift_month(month, -(months_back - 1))?;
    let (chart_start, _) = month_bounds(&first)?;
    let ids: Vec<String> = cards.iter().map(|c| c.id.clone()).collect();
    let found = monthly_flow(
        conn,
        &ids,
        &chart_start.format("%Y-%m-%d").to_string(),
        &end_s,
    )?;
    let mut monthly = Vec::with_capacity(months_back as usize);
    for back in (0..months_back).rev() {
        let m = shift_month(month, -back)?;
        let point = found.iter().find(|p| p.bucket == m);
        monthly.push(FlowPoint {
            bucket: m,
            income: point.map_or(0, |p| p.income),
            expense: point.map_or(0, |p| p.expense),
        });
    }

    Ok(CardsOverview {
        month: month.to_string(),
        span: span as u32,
        outstanding: cards.iter().map(|c| c.outstanding).sum(),
        credit_limit: cards.iter().map(|c| c.credit_limit).sum(),
        available: cards.iter().map(|c| c.available).sum(),
        billed: cards.iter().map(|c| c.billed).sum(),
        unbilled: cards.iter().map(|c| c.unbilled).sum(),
        spend: cards.iter().map(|c| c.spend).sum(),
        prev_spend: cards.iter().map(|c| c.prev_spend).sum(),
        paid: cards.iter().map(|c| c.paid).sum(),
        monthly,
        cards,
    })
}

// ----------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{new_id, now};

    /// A book on disk, because `db::open` is what brings the schema up.
    fn book() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("midas-cards-{}.sqlite3", new_id()));
        let conn = db::open(&path).unwrap();
        (conn, path)
    }

    fn account(conn: &Connection, kind: &str, limit: Paise, statement: i64, due: i64) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO accounts (id, name, kind, institution, opening_balance, color, icon,
                                   archived, sort_order, created_at, credit_limit,
                                   statement_day, due_day)
             VALUES (?1, 'Card', ?2, NULL, 0, '#118ae4', 'credit-card', 0, 0, ?3, ?4, ?5, ?6)",
            params![id, kind, now(), limit, statement, due],
        )
        .unwrap();
        id
    }

    /// The terms as the account row itself carries them: the copy the rest
    /// of the app reads in passing.
    fn row_of(conn: &Connection, card: &str) -> (Paise, i64, i64) {
        conn.query_row(
            "SELECT credit_limit, statement_day, due_day FROM accounts WHERE id = ?1",
            params![card],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    fn post(
        conn: &Connection,
        kind: &str,
        amount: Paise,
        from: &str,
        to: Option<&str>,
        on: NaiveDate,
        refund_of: Option<&str>,
    ) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO transactions (id, kind, amount, account_id, to_account_id,
                                       category_id, merchant, note, occurred_at, created_at,
                                       refund_of)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'Shop', NULL, ?6, ?7, ?8)",
            params![id, kind, amount, from, to, format!("{on}T09:00"), now(), refund_of],
        )
        .unwrap();
        id
    }

    /// Two months rather than one, because these tests date their postings
    /// by counting back from today: a charge "ten days ago" is last month for
    /// the first ten days of every month, and a one-month window would drop
    /// it. The window is what the figures are read over, so it has to be wide
    /// enough to hold what the test wrote whatever day the test is run.
    fn only_card(conn: &Connection) -> CardStat {
        let month = Utc::now().format("%Y-%m").to_string();
        cards_overview(conn, &month, 2, None, None).unwrap().cards.remove(0)
    }

    /// A cycle day the month is too short for falls on the last day it has,
    /// and a due day is always found *after* the statement that raised it.
    #[test]
    fn a_cycle_lands_on_a_day_the_month_actually_has() {
        let day = |y, m, d| NaiveDate::from_ymd_opt(y, m, d).unwrap();
        assert_eq!(day_in(2026, 2, 31), day(2026, 2, 28));
        assert_eq!(day_in(2028, 2, 31), day(2028, 2, 29));
        assert_eq!(last_on_or_before(day(2026, 3, 5), 31), day(2026, 2, 28));
        assert_eq!(last_on_or_before(day(2026, 3, 31), 31), day(2026, 3, 31));
        // Billed on the 2nd: due on the 22nd is this month, due on the 1st is
        // next month, and never the same day it was billed.
        assert_eq!(first_after(day(2026, 2, 2), 22), day(2026, 2, 22));
        assert_eq!(first_after(day(2026, 2, 2), 1), day(2026, 3, 1));
        assert_eq!(first_after(day(2026, 2, 2), 2), day(2026, 3, 2));
    }

    /// The statement is not stored anywhere: it is the balance, walked back
    /// through everything that has happened since it closed.
    #[test]
    fn the_statement_is_read_back_out_of_the_balance() {
        let (conn, _path) = book();
        let closed = today() - Duration::days(10);
        let card = account(&conn, "credit", 20_000_00, closed.day() as i64, 0);
        let bank = account(&conn, "bank", 0, 0, 0);

        // On the statement: two charges before it closed.
        post(&conn, "expense", 3_000_00, &card, None, closed - Duration::days(5), None);
        post(&conn, "expense", 2_000_00, &card, None, closed, None);
        // Since: another charge, and a payment against the bill.
        post(&conn, "expense", 3_000_00, &card, None, closed + Duration::days(2), None);
        post(&conn, "transfer", 2_000_00, &bank, Some(&card), closed + Duration::days(3), None);

        let stat = only_card(&conn);
        assert_eq!(stat.outstanding, 6_000_00);
        assert_eq!(stat.statement_total, 5_000_00);
        // Payments pay the bill off first, and what was spent since is not
        // on any bill yet.
        assert_eq!(stat.billed, 3_000_00);
        assert_eq!(stat.unbilled, 3_000_00);
        assert_eq!(stat.paid_since, 2_000_00);
        // The two halves are the whole: whatever else changes, this holds.
        assert_eq!(stat.billed + stat.unbilled, stat.outstanding);
        assert_eq!(stat.available, 14_000_00);
        assert_eq!(stat.statement_on.as_deref(), Some(iso(closed).as_str()));
    }

    /// Overpaying clears the bill and starts on what is not billed yet.
    #[test]
    fn paying_past_the_bill_eats_into_the_unbilled() {
        let (conn, _path) = book();
        let closed = today() - Duration::days(10);
        let card = account(&conn, "credit", 0, closed.day() as i64, 0);
        let bank = account(&conn, "bank", 0, 0, 0);

        post(&conn, "expense", 5_000_00, &card, None, closed - Duration::days(1), None);
        post(&conn, "expense", 3_000_00, &card, None, closed + Duration::days(2), None);
        post(&conn, "transfer", 6_000_00, &bank, Some(&card), closed + Duration::days(3), None);

        let stat = only_card(&conn);
        assert_eq!(stat.outstanding, 2_000_00);
        assert_eq!(stat.billed, 0);
        assert_eq!(stat.unbilled, 2_000_00);
        assert_eq!(stat.billed + stat.unbilled, stat.outstanding);
        // No limit set, so nothing is known about the room left on it.
        assert_eq!(stat.available, 0);
    }

    /// A card whose cycle nobody has told the book about owes all of it now,
    /// rather than being carved into halves that were made up.
    #[test]
    fn a_card_with_no_cycle_owes_it_all_now() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 0, 0, 0);
        post(&conn, "expense", 1_500_00, &card, None, today() - Duration::days(3), None);

        let stat = only_card(&conn);
        assert_eq!(stat.outstanding, 1_500_00);
        assert_eq!((stat.billed, stat.statement_total), (0, 0));
        assert_eq!(stat.unbilled, 1_500_00);
        assert!(stat.statement_on.is_none() && stat.due_on.is_none());
        assert!(stat.cycles.is_empty());
    }

    /// The cycles run end to end with no day in neither, and the last one is
    /// still open — it closes in the future.
    #[test]
    fn the_cycles_run_end_to_end() {
        let (conn, _path) = book();
        let closed = today() - Duration::days(10);
        let card = account(&conn, "credit", 0, closed.day() as i64, 0);
        post(&conn, "expense", 1_000_00, &card, None, closed - Duration::days(1), None);
        post(&conn, "expense", 400_00, &card, None, closed + Duration::days(1), None);

        let stat = only_card(&conn);
        assert_eq!(stat.cycles.len(), (CYCLES_BACK + 1) as usize);
        for pair in stat.cycles.windows(2) {
            let ended = NaiveDate::parse_from_str(&pair[0].closed_on, "%Y-%m-%d").unwrap();
            let starts = NaiveDate::parse_from_str(&pair[1].from, "%Y-%m-%d").unwrap();
            assert_eq!(starts, ended + Duration::days(1));
        }
        let open = stat.cycles.last().unwrap();
        assert!(open.open);
        assert_eq!(open.spend, 400_00);
        let last_closed = &stat.cycles[stat.cycles.len() - 2];
        assert!(!last_closed.open);
        assert_eq!(last_closed.spend, 1_000_00);
    }

    /// A window given in days is read as days: only what falls inside it
    /// counts, and what it is compared against is the same run of days
    /// immediately before — which is how a cycle is read against the cycle
    /// before it, whatever days the bank's own dates fall on.
    #[test]
    fn a_window_given_in_days_counts_only_those_days() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 0, 0, 0);
        let day = today();
        post(&conn, "expense", 500_00, &card, None, day - Duration::days(15), None);
        post(&conn, "expense", 300_00, &card, None, day - Duration::days(5), None);

        let month = Utc::now().format("%Y-%m").to_string();
        let from = iso(day - Duration::days(9));
        let to = iso(day);
        let stat = cards_overview(&conn, &month, 1, Some(&from), Some(&to))
            .unwrap()
            .cards
            .remove(0);
        // The last ten days hold one charge; the ten before them hold the other.
        assert_eq!(stat.spend, 300_00);
        assert_eq!(stat.charges, 1);
        assert_eq!(stat.prev_spend, 500_00);

        // No opening day is the whole of the card's life, and nothing came
        // before it to compare against.
        let all = cards_overview(&conn, &month, 1, None, Some("9999-12-31"))
            .unwrap()
            .cards
            .remove(0);
        assert_eq!(all.spend, 800_00);
        assert_eq!(all.charges, 2);
        assert_eq!(all.prev_spend, 0);
    }

    /// A limit that has been raised is read as it stood at the time: the
    /// window that closed before the raise is against the old figure, and
    /// what the card is on now follows the newest change dated today or
    /// before.
    #[test]
    fn a_window_is_read_against_the_limit_of_its_own_day() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 50_000_00, 0, 0);
        let day = today();
        let raised = day - Duration::days(30);

        save_card_term(&conn, &card, &iso(raised), Some(2_00_000_00), None, None, None, None, Some("raised"))
            .unwrap();
        save_card_term(
            &conn,
            &card,
            &iso(raised - Duration::days(400)),
            Some(80_000_00),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // The newest change dated on or before today is the limit now, so
        // the card itself has been moved to match.
        let month = Utc::now().format("%Y-%m").to_string();
        let now_stat = cards_overview(&conn, &month, 1, None, None).unwrap().cards.remove(0);
        assert_eq!(now_stat.credit_limit, 2_00_000_00);
        assert_eq!(now_stat.window_credit_limit, 2_00_000_00);

        // A window that closed the day before the raise is read against what
        // the limit was then.
        let before = iso(raised - Duration::days(1));
        let older = cards_overview(&conn, &month, 1, Some(&iso(raised - Duration::days(31))), Some(&before))
            .unwrap()
            .cards
            .remove(0);
        assert_eq!(older.window_credit_limit, 80_000_00);
        assert_eq!(older.credit_limit, 2_00_000_00);

        // Nothing recorded that far back: the earliest figure on file is a
        // better answer than the one the card is on today.
        let ancient = iso(raised - Duration::days(900));
        let far = cards_overview(&conn, &month, 1, Some(&ancient), Some(&ancient))
            .unwrap()
            .cards
            .remove(0);
        assert_eq!(far.window_credit_limit, 80_000_00);

        // Taking the raise back out puts the card back on the older limit.
        let raise = card_terms(&conn, &card)
            .unwrap()
            .into_iter()
            .find(|t| t.credit_limit == Some(2_00_000_00))
            .unwrap();
        delete_card_term(&conn, &raise.id).unwrap();
        let after = cards_overview(&conn, &month, 1, None, None).unwrap().cards.remove(0);
        assert_eq!(after.credit_limit, 80_000_00);
    }

    /// Saving the account form leaves a card's terms exactly where they are.
    /// They belong to the changes recorded against it, and a form that wrote
    /// its own blanks over them would take the cycle off a card every time
    /// its name was corrected — which is what it did.
    #[test]
    fn saving_the_account_leaves_the_terms_alone() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 0, 0, 0);
        save_card_term(
            &conn,
            &card,
            &iso(today() - Duration::days(10)),
            Some(1_00_000_00),
            Some(2),
            Some(22),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(row_of(&conn, &card), (1_00_000_00, 2, 22));

        db::save_account(
            &conn,
            AccountInput {
                id: Some(card.clone()),
                name: "Swiggy HDFC".into(),
                kind: "credit".into(),
                institution: None,
                opening_balance: 0,
                color: "#118ae4".into(),
                icon: "credit-card".into(),
            },
        )
        .unwrap();

        assert_eq!(row_of(&conn, &card), (1_00_000_00, 2, 22));

        // And the card still reads by its own cycle rather than by the month.
        let month = Utc::now().format("%Y-%m").to_string();
        let stat = cards_overview(&conn, &month, 1, None, None).unwrap().cards.remove(0);
        assert_eq!(stat.statement_day, 2);
        assert!(!stat.cycles.is_empty());
    }

    /// Even a card whose account row has lost its terms is read by what was
    /// recorded against it: the changes are the card, and the row is a copy.
    #[test]
    fn the_recorded_terms_outrank_the_account_row() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 0, 0, 0);
        save_card_term(&conn, &card, &iso(today() - Duration::days(40)), None, Some(2), Some(22), None, None, None)
            .unwrap();
        // As if something had blanked the copy behind the card's back.
        conn.execute(
            "UPDATE accounts SET statement_day = 0, due_day = 0 WHERE id = ?1",
            params![card],
        )
        .unwrap();

        let month = Utc::now().format("%Y-%m").to_string();
        let stat = cards_overview(&conn, &month, 1, None, None).unwrap().cards.remove(0);
        assert_eq!(stat.statement_day, 2);
        assert_eq!(stat.due_day, 22);
        assert!(!stat.cycles.is_empty());
    }

    /// A change dated ahead is a card the bank has told you about and not
    /// yet moved: it colours nothing before it, today included.
    #[test]
    fn a_change_that_has_not_happened_yet_changes_nothing_yet() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 50_000_00, 5, 22);
        let ahead = iso(today() + Duration::days(30));
        save_card_term(&conn, &card, &ahead, Some(3_00_000_00), Some(20), None, None, None, None).unwrap();

        let month = Utc::now().format("%Y-%m").to_string();
        let stat = cards_overview(&conn, &month, 1, None, None).unwrap().cards.remove(0);
        assert_eq!(stat.credit_limit, 50_000_00);
        assert_eq!(stat.window_credit_limit, 50_000_00);
        assert_eq!(stat.statement_day, 5);
        // …and the cycles running now are still cut on the day it is on.
        let open = stat.cycles.last().unwrap();
        assert_eq!(&open.closed_on[8..], "05");
    }

    /// A statement day the bank moved splits the cycles where it actually
    /// moved: the cycles before it close on the old day, the one across the
    /// change is short, and no day falls in neither or in both.
    #[test]
    fn a_statement_day_that_moved_splits_the_cycles_where_it_moved() {
        let (conn, _path) = book();
        // The card is on the 20th now; it was on the 5th until four months
        // ago. Only the change says so — the account carries today's terms.
        let card = account(&conn, "credit", 0, 20, 0);
        let moved = day_in(today().year(), today().month(), 1) - Duration::days(100);
        save_card_term(&conn, &card, &iso(moved), None, Some(20), None, None, None, None).unwrap();
        save_card_term(
            &conn,
            &card,
            &iso(moved - Duration::days(700)),
            None,
            Some(5),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let month = Utc::now().format("%Y-%m").to_string();
        let stat = cards_overview(&conn, &month, 1, None, None).unwrap().cards.remove(0);

        // Still end to end, however the day moved under them.
        for pair in stat.cycles.windows(2) {
            let ended = NaiveDate::parse_from_str(&pair[0].closed_on, "%Y-%m-%d").unwrap();
            let starts = NaiveDate::parse_from_str(&pair[1].from, "%Y-%m-%d").unwrap();
            assert_eq!(starts, ended + Duration::days(1));
        }
        // Every cycle that closed after the change closes on the 20th, and
        // the ones before it on the 5th — bar the one the change cut short,
        // which is the first to close on the new day.
        let closes: Vec<NaiveDate> = stat
            .cycles
            .iter()
            .map(|c| NaiveDate::parse_from_str(&c.closed_on, "%Y-%m-%d").unwrap())
            .collect();
        for close in &closes {
            let day = if *close >= moved { 20 } else { 5 };
            assert_eq!(close.day(), day, "cycle closing {close} is on the wrong day");
        }
    }

    /// Every card together, month by month — calendar months, because two
    /// cards close on different days and only the calendar is common.
    #[test]
    fn the_months_across_the_cards_have_no_gaps() {
        let (conn, _path) = book();
        let card = account(&conn, "credit", 0, 2, 22);
        let other = account(&conn, "credit", 0, 0, 0);
        let bank = account(&conn, "bank", 0, 0, 0);
        // Anchored to the month rather than counted back from today. This
        // test asserts on one month exactly, and "three days ago" is last
        // month for the first three days of every month — which quietly
        // emptied the figures it checks.
        let this_month = today().with_day(1).unwrap();
        let last_month = this_month - Duration::days(15);

        post(&conn, "expense", 1_000_00, &card, None, this_month, None);
        post(&conn, "expense", 400_00, &other, None, this_month, None);
        post(&conn, "transfer", 600_00, &bank, Some(&card), this_month, None);
        post(&conn, "expense", 250_00, &card, None, last_month, None);

        let month = Utc::now().format("%Y-%m").to_string();
        let all = cards_overview(&conn, &month, 1, None, None).unwrap();
        // Twelve months, oldest first, none of them missing.
        assert_eq!(all.monthly.len(), 12);
        assert_eq!(all.monthly.last().unwrap().bucket, month);
        let this = all.monthly.last().unwrap();
        assert_eq!(this.expense, 1_400_00);
        assert_eq!(this.income, 600_00);
        // The window totals agree with the month the window is.
        assert_eq!(all.spend, 1_400_00);
        assert_eq!(all.paid, 600_00);
    }

    /// Two arithmetics, both right: the cycle counts the credit where the
    /// bank put it, and spending counts neither the charge nor the refund.
    #[test]
    fn a_refund_credits_the_cycle_and_cancels_the_spending() {
        let (conn, _path) = book();
        let closed = today() - Duration::days(10);
        let card = account(&conn, "credit", 0, closed.day() as i64, 0);

        let bill = post(&conn, "expense", 2_000_00, &card, None, closed + Duration::days(1), None);
        post(&conn, "expense", 500_00, &card, None, closed + Duration::days(2), None);
        post(
            &conn,
            "income",
            2_000_00,
            &card,
            None,
            closed + Duration::days(4),
            Some(&bill),
        );

        let stat = only_card(&conn);
        // The money came back, so only the other charge is still owed.
        assert_eq!(stat.outstanding, 500_00);
        // The open cycle: charged ₹2,500, credited ₹2,000.
        assert_eq!(stat.cycles.last().unwrap().spend, 500_00);
        // And as spending, the refunded bill never happened.
        assert_eq!(stat.spend, 500_00);
        assert_eq!(stat.top_merchants[0].total, 500_00);
    }
}
