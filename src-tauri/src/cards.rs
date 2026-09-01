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

use crate::db::{self, month_bounds, oops, shift_month, Result, NOT_A_REFUND, REFUNDED};
use crate::models::*;

/// How many closed cycles the card carries with it, before the open one.
const CYCLES_BACK: i64 = 12;

fn today() -> NaiveDate {
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

fn iso(date: NaiveDate) -> String {
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
                                      THEN t.amount ELSE 0 END), 0)
             FROM transactions t
             WHERE t.account_id = ?1 OR t.to_account_id = ?1
             GROUP BY day ORDER BY day",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![card], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Movement { charged: r.get(1)?, credited: r.get(2)?, paid: r.get(3)? },
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
            sum
        })
}

/// What the card was spent on over a window, the book's way: expenses only,
/// less whatever has been refunded against them. A payment is not spending
/// and neither is a refund, so neither is in here.
fn netted_spend(conn: &Connection, card: &str, from: &str, to: &str) -> Result<(Paise, i64)> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(t.amount - {REFUNDED}), 0), COUNT(*)
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
            "SELECT t.merchant, SUM(t.amount - {REFUNDED}), COUNT(*)
             FROM transactions t
             WHERE t.account_id = ?1 AND t.kind = 'expense' AND {NOT_A_REFUND}
               AND t.merchant <> '' AND t.occurred_at >= ?2 AND t.occurred_at <= ?3
             GROUP BY LOWER(t.merchant)
             HAVING SUM(t.amount - {REFUNDED}) > 0
             ORDER BY SUM(t.amount - {REFUNDED}) DESC LIMIT 5"
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

/// The cycles a card has been through, oldest first, with the one still
/// running last. Empty when the card keeps no cycle: there is nothing to
/// divide the months into, and inventing a division would be a lie.
fn cycles_of(days: &[(NaiveDate, Movement)], statement_day: i64, on: NaiveDate) -> Vec<CardCycle> {
    if statement_day == 0 {
        return Vec::new();
    }
    // The open cycle runs from the day after the last statement to the next
    // one, which has not happened yet.
    let last = last_on_or_before(on, statement_day);
    let mut closes: Vec<NaiveDate> = Vec::new();
    let mut walk = last;
    for _ in 0..CYCLES_BACK {
        closes.push(walk);
        walk = last_on_or_before(walk - Duration::days(1), statement_day);
    }
    closes.reverse();
    closes.push(first_after(on, statement_day));

    closes
        .iter()
        .map(|close| {
            let from = last_on_or_before(*close - Duration::days(1), statement_day)
                + Duration::days(1);
            let m = between(days, from, *close);
            CardCycle {
                from: iso(from),
                closed_on: iso(*close),
                spend: m.charged - m.credited,
                paid: m.paid,
                open: *close > on,
            }
        })
        .collect()
}

/// One card, whole.
fn stat_of(
    conn: &Connection,
    card: &Account,
    month: &str,
    span: i32,
    start: &str,
    end: &str,
) -> Result<CardStat> {
    let now = today();
    let days = movements(conn, &card.id)?;

    // What is owed, and what is left of the limit. A card sitting in credit
    // owes nothing and has its whole limit — plus the credit — to spend.
    let owed = (-card.balance).max(0);
    let available = if card.credit_limit > 0 {
        (card.credit_limit - owed).max(0)
    } else {
        0
    };

    // The statement, worked backwards from the balance. Everything that has
    // happened since it closed is taken back off, which leaves what it said.
    let (statement_on, due_on, statement_total, billed, unbilled, paid_since) =
        if card.statement_day > 0 {
            let closed = last_on_or_before(now, card.statement_day);
            let since = between(&days, closed + Duration::days(1), now);
            let statement = owed + since.credited - since.charged + since.paid;
            // Payments since the statement pay the bill off first, which is
            // what a bank does with them and what anybody paying one means.
            let still_due = (statement - since.paid).clamp(0, owed);
            let due = if card.due_day > 0 {
                Some(iso(first_after(closed, card.due_day)))
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

    let (spend, charges) = netted_spend(conn, &card.id, start, end)?;
    // The window immediately before this one, of the same length, so a year
    // is compared against a year rather than against a single month.
    let prev_month = shift_month(month, -span)?;
    let (pstart, _) = month_bounds(&shift_month(&prev_month, -(span - 1))?)?;
    let (_, pend) = month_bounds(&prev_month)?;
    let (prev_spend, _) = netted_spend(
        conn,
        &card.id,
        &pstart.format("%Y-%m-%d").to_string(),
        &format!("{}T23:59:59", pend.format("%Y-%m-%d")),
    )?;

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
        credit_limit: card.credit_limit,
        available,
        statement_day: card.statement_day,
        due_day: card.due_day,
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
        cycles: cycles_of(&days, card.statement_day, now),
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
                                  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
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

/// Every card in the book, in the order the accounts screen keeps them.
/// Archived cards are left out: a card you have closed is history, and the
/// Accounts screen is where history is kept.
pub fn cards_overview(conn: &Connection, month: &str, span: u32) -> Result<CardsOverview> {
    let span = span.max(1) as i32;
    let first_month = shift_month(month, -(span - 1))?;
    let (start, _) = month_bounds(&first_month)?;
    let (_, end) = month_bounds(month)?;
    let start_s = start.format("%Y-%m-%d").to_string();
    let end_s = format!("{}T23:59:59", end.format("%Y-%m-%d"));

    let accounts = db::list_accounts(conn)?;
    let mut cards = Vec::new();
    for card in accounts.iter().filter(|a| a.kind == "credit" && !a.archived) {
        cards.push(stat_of(conn, card, month, span, &start_s, &end_s)?);
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
        cards_overview(conn, &month, 2).unwrap().cards.remove(0)
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
        let all = cards_overview(&conn, &month, 1).unwrap();
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
