//! Planned payments: the money that comes round again.
//!
//! A plan is a promise — this much, this often, from this day — plus the
//! postings somebody has said belong to it. Nothing else. It does not go
//! looking for payments and it never claims one on its own.
//!
//! That is a deliberate retreat from cleverness. Guessing by payee cannot
//! tell an iCloud subscription from an Apple TV one, because the bank calls
//! both of them "Apple"; guessing by amount as well only means the day one
//! of them changes price it silently attaches to the other. The only thing
//! that reliably knows which payment belongs to which plan is the person who
//! made it, so that is who is asked.
//!
//! What is *not* stored is the tally. Which cycles were paid, what it has
//! cost, when it next falls due — all of that is read back off the linked
//! postings every time it is asked for, so deleting a posting or correcting
//! its date fixes the plan for free.

use chrono::{Datelike, Duration, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

use crate::db::{self, new_id, now, oops, Result};
use crate::models::*;

/* ------------------------------------------------------------- the calendar */

/// How a cadence moves: by whole days, or by whole months. The two cannot be
/// the same arithmetic — a month is not thirty days, and a plan anchored on
/// the 31st has to keep landing on month ends rather than sliding backwards.
#[derive(Clone, Copy, PartialEq)]
enum Step {
    Days(i64),
    Months(i64),
}

fn step_of(cadence: &str) -> Step {
    match cadence {
        "weekly" => Step::Days(7),
        "fortnightly" => Step::Days(14),
        "monthly" => Step::Months(1),
        "quarterly" => Step::Months(3),
        "half_yearly" => Step::Months(6),
        _ => Step::Months(12),
    }
}

pub const CADENCES: [&str; 6] = [
    "weekly",
    "fortnightly",
    "monthly",
    "quarterly",
    "half_yearly",
    "yearly",
];

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

/// The same day of the month, `months` on — clamped to the last day when the
/// month it lands in is too short to hold it.
fn add_months(date: NaiveDate, months: i64) -> NaiveDate {
    let total = date.year() as i64 * 12 + date.month0() as i64 + months;
    let year = total.div_euclid(12) as i32;
    let month = total.rem_euclid(12) as u32 + 1;
    let day = date.day().min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day).unwrap_or(date)
}

/// The `n`th due date of a plan, counted from its anchor. Always measured
/// from the anchor rather than from the one before it, so a plan cannot
/// drift a day a month across a year of clamped February dates.
fn nth_due(anchor: NaiveDate, cadence: &str, every: i64, n: i64) -> NaiveDate {
    match step_of(cadence) {
        Step::Days(d) => anchor + Duration::days(d * every * n),
        Step::Months(m) => add_months(anchor, m * every * n),
    }
}

/// Roughly how long one cycle runs. Only ever used to size a window, so a
/// month being thirty days here costs nothing.
fn cycle_days(cadence: &str, every: i64) -> i64 {
    let base = match step_of(cadence) {
        Step::Days(d) => d,
        Step::Months(1) => 30,
        Step::Months(3) => 91,
        Step::Months(6) => 182,
        Step::Months(_) => 365,
    };
    (base * every).max(1)
}

fn div_round(num: i128, den: i128) -> i128 {
    if den == 0 {
        return 0;
    }
    let half = den.abs() / 2;
    if (num < 0) == (den < 0) {
        (num + half * num.signum() * den.signum().abs()) / den
    } else {
        (num - half) / den
    }
}

/// What a plan comes to over a year, whatever rhythm it keeps.
fn yearly_of(amount: Paise, cadence: &str, every: i64) -> Paise {
    let every = every.max(1) as i128;
    let amount = amount as i128;
    let value = match step_of(cadence) {
        Step::Days(7) => div_round(amount * 52, every),
        Step::Days(14) => div_round(amount * 26, every),
        Step::Days(d) => div_round(amount * 365, d as i128 * every),
        Step::Months(m) => div_round(amount * 12, m as i128 * every),
    };
    value as Paise
}

fn monthly_of(amount: Paise, cadence: &str, every: i64) -> Paise {
    div_round(yearly_of(amount, cadence, every) as i128, 12) as Paise
}

fn today() -> NaiveDate {
    Utc::now().date_naive()
}

fn parse_day(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(&text[..text.len().min(10)], "%Y-%m-%d").ok()
}

/* ------------------------------------------------------------ stored plans */

/// A plan exactly as the table holds it, with the names it is shown under
/// joined on. Everything derived is worked out from this plus the ledger.
struct PlanRow {
    id: String,
    name: String,
    kind: String,
    amount: Paise,
    account_id: Option<String>,
    account_name: Option<String>,
    account_color: Option<String>,
    to_account_id: Option<String>,
    to_account_name: Option<String>,
    category_id: Option<String>,
    category_name: Option<String>,
    category_icon: Option<String>,
    category_color: Option<String>,
    merchant: String,
    note: Option<String>,
    cadence: String,
    every: i64,
    anchor_on: String,
    ends_on: Option<String>,
    automatic: bool,
    variable: bool,
    skipped_through: Option<String>,
    match_key: Option<String>,
    archived: bool,
    created_at: String,
}

const PLAN_SELECT: &str = "
SELECT p.id, p.name, p.kind, p.amount, p.account_id, a.name, a.color,
       p.to_account_id, ta.name, p.category_id, c.name, c.icon, c.color,
       p.merchant, p.note, p.cadence, p.every, p.anchor_on, p.ends_on,
       p.automatic, p.variable, p.skipped_through, p.match_key, p.archived,
       p.created_at
FROM plans p
LEFT JOIN accounts a   ON a.id = p.account_id
LEFT JOIN accounts ta  ON ta.id = p.to_account_id
LEFT JOIN categories c ON c.id = p.category_id
";

fn plan_from_row(r: &rusqlite::Row) -> rusqlite::Result<PlanRow> {
    Ok(PlanRow {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        amount: r.get(3)?,
        account_id: r.get(4)?,
        account_name: r.get(5)?,
        account_color: r.get(6)?,
        to_account_id: r.get(7)?,
        to_account_name: r.get(8)?,
        category_id: r.get(9)?,
        category_name: r.get(10)?,
        category_icon: r.get(11)?,
        category_color: r.get(12)?,
        merchant: r.get(13)?,
        note: r.get(14)?,
        cadence: r.get(15)?,
        every: r.get::<_, i64>(16)?.max(1),
        anchor_on: r.get(17)?,
        ends_on: r.get(18)?,
        automatic: r.get::<_, i64>(19)? != 0,
        variable: r.get::<_, i64>(20)? != 0,
        skipped_through: r.get(21)?,
        match_key: r.get(22)?,
        archived: r.get::<_, i64>(23)? != 0,
        created_at: r.get(24)?,
    })
}

/// One posting the ledger offers up as this plan's.
#[derive(Clone)]
struct Paid {
    id: String,
    day: NaiveDate,
    amount: Paise,
}

/// The postings somebody has said belong to this plan, oldest first.
///
/// There is no guessing here and there is deliberately nowhere for any to
/// creep in: a payment counts for a plan when, and only when, it has been
/// linked to it.
fn paid_postings(conn: &Connection, plan: &PlanRow) -> Result<Vec<Paid>> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, substr(t.occurred_at, 1, 10) AS on_day, t.amount
             FROM plan_entries e
             JOIN transactions t ON t.id = e.transaction_id
             WHERE e.plan_id = ?1
             ORDER BY on_day",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![plan.id], |r| {
            Ok(Paid {
                id: r.get(0)?,
                day: parse_day(&r.get::<_, String>(1)?).unwrap_or_else(today),
                amount: r.get(2)?,
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

/// One turn of the wheel, with whatever the ledger put against it.
struct Cycle {
    due: NaiveDate,
    paid: Option<Paid>,
}

/// Lays a plan's due dates out around its anchor, and hands each one the
/// payment that belongs to it.
///
/// The anchor is any date the cycle lands on, not necessarily the first: a
/// bill whose day has moved is best counted from the day it falls on *now*,
/// so that what it will do next is right. History is picked up by walking
/// backwards from the anchor as far as the earliest linked payment.
///
/// Every linked payment lands somewhere — each takes the nearest cycle still
/// free. There is no tolerance to fall outside of, because there is nothing
/// to protect against: a payment is only here because somebody put it here,
/// and quietly dropping it off the chart for being three weeks late would
/// just be losing their work.
fn cycles(plan: &PlanRow, postings: &[Paid], horizon: NaiveDate) -> Vec<Cycle> {
    let Some(anchor) = parse_day(&plan.anchor_on) else {
        return Vec::new();
    };
    let ends = plan.ends_on.as_deref().and_then(parse_day);

    // Far enough back to cover the oldest payment, and no further — a plan
    // with nothing linked starts at its anchor rather than inventing years
    // of cycles nobody ever owed.
    let mut first = 0i64;
    if let Some(earliest) = postings.first().map(|p| p.day) {
        while first > -600 && nth_due(anchor, &plan.cadence, plan.every, first) > earliest {
            first -= 1;
        }
    }

    let mut dues: Vec<NaiveDate> = Vec::new();
    for n in first..(first + 4_000) {
        let due = nth_due(anchor, &plan.cadence, plan.every, n);
        if due > horizon || ends.is_some_and(|e| due > e) {
            break;
        }
        dues.push(due);
    }

    let mut paid: Vec<Option<Paid>> = vec![None; dues.len()];
    for posting in postings {
        let nearest = dues
            .iter()
            .enumerate()
            .filter(|(i, _)| paid[*i].is_none())
            .min_by_key(|(_, due)| (posting.day - **due).num_days().abs())
            .map(|(i, _)| i);
        if let Some(i) = nearest {
            paid[i] = Some(posting.clone());
        }
    }

    dues.into_iter()
        .zip(paid)
        .map(|(due, paid)| Cycle { due, paid })
        .collect()
}

/// Folds a stored plan and its linked postings into what the screens read.
fn hydrate(conn: &Connection, plan: PlanRow) -> Result<Plan> {
    let postings = paid_postings(conn, &plan)?;
    let now_day = today();
    // Far enough ahead to always hold the next due date, and the one after
    // it — a yearly plan needs a longer runway than a weekly one.
    let last_seen = postings.last().map(|p| p.day).unwrap_or(now_day);
    let horizon =
        last_seen.max(now_day) + Duration::days(cycle_days(&plan.cadence, plan.every) * 2 + 40);
    let turns = cycles(&plan, &postings, horizon);
    let skipped_through = plan.skipped_through.as_deref().and_then(parse_day);
    let ends = plan.ends_on.as_deref().and_then(parse_day);

    let last_paid_index = turns.iter().rposition(|c| c.paid.is_some());
    let from = last_paid_index.map(|i| i + 1).unwrap_or(0);
    // Cycles still owed: after the last one that was paid, never let go, and
    // already gone by.
    let owing: Vec<&Cycle> = turns[from.min(turns.len())..]
        .iter()
        .filter(|c| c.paid.is_none() && !skipped_through.is_some_and(|s| c.due <= s))
        .collect();
    let missed = owing.iter().filter(|c| c.due < now_day).count() as i64;

    let paid_count = postings.len() as i64;
    // Three cycles with nothing against them is not a bill running late, it
    // is a subscription that ended somewhere the book never saw. Point such a
    // plan at the next date it would fall on rather than at a debt from
    // spring, and let the screen offer to put it away.
    //
    // A plan with nothing linked to it yet is not lapsed, whatever its dates
    // say — it is new, and being new is not a fault.
    let lapsed = missed >= 3 && paid_count > 0;
    let next_due = if lapsed {
        owing.iter().find(|c| c.due >= now_day).or_else(|| owing.last()).map(|c| c.due)
    } else {
        owing.first().map(|c| c.due)
    };

    let observed_total = postings.iter().map(|p| p.amount).sum::<Paise>();
    let last_amount = postings.last().map(|p| p.amount).unwrap_or(0);
    let recent_window = &postings[postings.len().saturating_sub(6)..];
    let average_amount = if recent_window.is_empty() {
        plan.amount
    } else {
        div_round(
            recent_window.iter().map(|p| p.amount as i128).sum::<i128>(),
            recent_window.len() as i128,
        ) as Paise
    };

    let status = if plan.archived {
        "archived"
    } else if next_due.is_none() || ends.is_some_and(|e| e < now_day) {
        "ended"
    } else if lapsed {
        "lapsed"
    } else if next_due.is_some_and(|d| d < now_day) {
        "overdue"
    } else if next_due == Some(now_day) {
        "due"
    } else {
        "upcoming"
    };

    Ok(Plan {
        id: plan.id,
        name: plan.name,
        kind: plan.kind.clone(),
        amount: plan.amount,
        account_id: plan.account_id,
        account_name: plan.account_name,
        account_color: plan.account_color,
        to_account_id: plan.to_account_id,
        to_account_name: plan.to_account_name,
        category_id: plan.category_id,
        category_name: plan.category_name,
        category_icon: plan.category_icon,
        category_color: plan.category_color,
        merchant: plan.merchant,
        note: plan.note,
        cadence: plan.cadence.clone(),
        every: plan.every,
        anchor_on: plan.anchor_on,
        ends_on: plan.ends_on,
        automatic: plan.automatic,
        variable: plan.variable,
        archived: plan.archived,
        match_key: plan.match_key,
        created_at: plan.created_at,
        next_due: next_due.map(|d| d.to_string()),
        days_until: next_due.map(|d| (d - now_day).num_days()),
        status: status.to_string(),
        missed,
        last_paid_on: postings.last().map(|p| p.day.to_string()),
        last_amount,
        average_amount,
        paid_count,
        observed_total,
        monthly_amount: monthly_of(plan.amount, &plan.cadence, plan.every),
        yearly_amount: yearly_of(plan.amount, &plan.cadence, plan.every),
        drift: if paid_count > 0 { last_amount - plan.amount } else { 0 },
        recent: recent_window
            .iter()
            .map(|p| PlanPosting {
                id: p.id.clone(),
                occurred_at: p.day.to_string(),
                amount: p.amount,
            })
            .collect(),
    })
}

/// Every plan, what is owed soonest first, with what is finished at the back.
pub fn list_plans(conn: &Connection) -> Result<Vec<Plan>> {
    let sql = format!("{PLAN_SELECT} ORDER BY p.archived, p.created_at");
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map([], plan_from_row)
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);

    let mut plans = Vec::with_capacity(rows.len());
    for row in rows {
        plans.push(hydrate(conn, row)?);
    }
    plans.sort_by(|a, b| {
        let rank = |p: &Plan| match p.status.as_str() {
            "archived" => 3,
            "ended" => 2,
            "lapsed" => 1,
            _ => 0,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| match (&a.next_due, &b.next_due) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| b.monthly_amount.cmp(&a.monthly_amount))
    });
    Ok(plans)
}

fn get_row(conn: &Connection, id: &str) -> Result<PlanRow> {
    let sql = format!("{PLAN_SELECT} WHERE p.id = ?1");
    conn.query_row(&sql, params![id], plan_from_row)
        .optional()
        .map_err(oops)?
        .ok_or_else(|| "That plan is not there any more.".to_string())
}

pub fn get_plan(conn: &Connection, id: &str) -> Result<Plan> {
    let row = get_row(conn, id)?;
    hydrate(conn, row)
}

pub fn save_plan(conn: &Connection, input: PlanInput) -> Result<Plan> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("What should this plan be called?".into());
    }
    if input.amount < 0 {
        return Err("A plan cannot be for less than nothing.".into());
    }
    if !CADENCES.contains(&input.cadence.as_str()) {
        return Err("That isn't a rhythm a plan can keep.".into());
    }
    if parse_day(&input.anchor_on).is_none() {
        return Err("A plan needs a date to count from.".into());
    }
    if input.kind == "transfer" && input.to_account_id.is_none() {
        return Err("A transfer needs an account to land in.".into());
    }
    let every = input.every.unwrap_or(1).max(1);
    let merchant = input.merchant.trim();
    let id = match input.id {
        Some(id) => {
            conn.execute(
                "UPDATE plans SET name = ?2, kind = ?3, amount = ?4, account_id = ?5,
                        to_account_id = ?6, category_id = ?7, merchant = ?8, note = ?9,
                        cadence = ?10, every = ?11, anchor_on = ?12, ends_on = ?13,
                        automatic = ?14, variable = ?15, match_key = ?16, archived = ?17
                 WHERE id = ?1",
                params![
                    id,
                    name,
                    input.kind,
                    input.amount,
                    input.account_id,
                    input.to_account_id,
                    input.category_id,
                    merchant,
                    input.note,
                    input.cadence,
                    every,
                    input.anchor_on,
                    input.ends_on,
                    input.automatic.unwrap_or(true) as i64,
                    input.variable.unwrap_or(false) as i64,
                    input.match_key,
                    input.archived.unwrap_or(false) as i64,
                ],
            )
            .map_err(oops)?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO plans (id, name, kind, amount, account_id, to_account_id,
                                    category_id, merchant, note, cadence, every, anchor_on,
                                    ends_on, automatic, variable, match_key, archived, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    id,
                    name,
                    input.kind,
                    input.amount,
                    input.account_id,
                    input.to_account_id,
                    input.category_id,
                    merchant,
                    input.note,
                    input.cadence,
                    every,
                    input.anchor_on,
                    input.ends_on,
                    input.automatic.unwrap_or(true) as i64,
                    input.variable.unwrap_or(false) as i64,
                    input.match_key,
                    input.archived.unwrap_or(false) as i64,
                    now(),
                ],
            )
            .map_err(oops)?;
            id
        }
    };
    get_plan(conn, &id)
}

pub fn delete_plan(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM plans WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

pub fn set_plan_archived(conn: &Connection, id: &str, archived: bool) -> Result<()> {
    conn.execute(
        "UPDATE plans SET archived = ?2 WHERE id = ?1",
        params![id, archived as i64],
    )
    .map_err(oops)?;
    Ok(())
}

/// Lets one cycle go by without paying it — a month the gym was closed, a
/// bill that was waived. Nothing is owed up to and including that date.
pub fn skip_plan(conn: &Connection, id: &str) -> Result<Plan> {
    let plan = get_plan(conn, id)?;
    let Some(due) = plan.next_due.clone() else {
        return Err("There is nothing due to skip.".into());
    };
    conn.execute(
        "UPDATE plans SET skipped_through = ?2 WHERE id = ?1",
        params![id, due],
    )
    .map_err(oops)?;
    get_plan(conn, id)
}

/// Records the cycle as paid by writing the posting it describes, and links
/// that posting to the plan — which is the only way anything ever counts.
pub fn pay_plan(
    conn: &Connection,
    id: &str,
    amount: Option<Paise>,
    occurred_at: Option<String>,
) -> Result<Transaction> {
    let row = get_row(conn, id)?;
    let plan = hydrate(conn, row)?;
    let Some(account_id) = plan.account_id.clone() else {
        return Err("Say which account this comes out of before paying it.".into());
    };
    let amount = amount.unwrap_or({
        if plan.variable && plan.average_amount > 0 { plan.average_amount } else { plan.amount }
    });
    if amount <= 0 {
        return Err("How much was it?".into());
    }
    // The day it fell due, unless told otherwise — a bill paid on time is
    // the ordinary case, and re-typing today's date for it is busywork.
    let when = occurred_at
        .or_else(|| plan.next_due.clone().map(|d| format!("{d}T09:00")))
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%dT%H:%M").to_string());

    let guard = conn.unchecked_transaction().map_err(oops)?;
    let tx = db::save_transaction(
        conn,
        TransactionInput {
            id: None,
            kind: plan.kind.clone(),
            amount,
            account_id,
            to_account_id: plan.to_account_id.clone(),
            category_id: plan.category_id.clone(),
            merchant: if plan.merchant.is_empty() { plan.name.clone() } else { plan.merchant.clone() },
            note: plan.note.clone(),
            occurred_at: when,
            splits: None,
            shares: None,
            label_ids: None,
        },
    )?;
    conn.execute(
        "INSERT INTO plan_entries (plan_id, transaction_id) VALUES (?1, ?2)",
        params![plan.id, tx.id],
    )
    .map_err(oops)?;
    guard.commit().map_err(oops)?;
    Ok(tx)
}

/// One plan's cycles, turned into what the screens draw.
fn occurrences_of(plan: &PlanRow, postings: &[Paid], horizon: NaiveDate) -> Vec<PlanOccurrence> {
    let skipped_through = plan.skipped_through.as_deref().and_then(parse_day);
    cycles(plan, postings, horizon)
        .into_iter()
        .map(|cycle| {
            let skipped =
                cycle.paid.is_none() && skipped_through.is_some_and(|s| cycle.due <= s);
            PlanOccurrence {
                plan_id: plan.id.clone(),
                name: plan.name.clone(),
                kind: plan.kind.clone(),
                due_on: cycle.due.to_string(),
                amount: plan.amount,
                merchant: plan.merchant.clone(),
                category_icon: plan.category_icon.clone(),
                category_color: plan.category_color.clone(),
                account_name: plan.account_name.clone(),
                automatic: plan.automatic,
                paid: cycle.paid.is_some(),
                transaction_id: cycle.paid.as_ref().map(|p| p.id.clone()),
                actual_amount: cycle.paid.as_ref().map(|p| p.amount).unwrap_or(0),
                skipped,
            }
        })
        .collect()
}

/// Every turn of every live plan between two dates — what the calendar draws.
/// Cycles already paid come back too, so a month reads as a bill calendar
/// rather than only as a list of what is still coming.
pub fn plan_calendar(conn: &Connection, from: &str, to: &str) -> Result<Vec<PlanOccurrence>> {
    let (Some(_start), Some(end)) = (parse_day(from), parse_day(to)) else {
        return Err("That isn't a window the calendar can show.".into());
    };
    let sql = format!("{PLAN_SELECT} WHERE p.archived = 0");
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map([], plan_from_row)
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    drop(stmt);

    let mut out = Vec::new();
    for plan in rows {
        let postings = paid_postings(conn, &plan)?;
        for occurrence in occurrences_of(&plan, &postings, end.max(today())) {
            if occurrence.due_on.as_str() >= from && occurrence.due_on.as_str() <= to {
                out.push(occurrence);
            }
        }
    }
    out.sort_by(|a, b| a.due_on.cmp(&b.due_on).then_with(|| b.amount.cmp(&a.amount)));
    Ok(out)
}

/// The whole life of one plan, oldest cycle first: every turn from the first
/// payment behind it to the next one owed, whether it was paid, let go, or
/// missed altogether.
///
/// This is what a plan's own page is made of — and the holes in it are the
/// interesting part, which is why the unpaid cycles come back rather than
/// being quietly left out.
pub fn plan_timeline(conn: &Connection, id: &str) -> Result<Vec<PlanOccurrence>> {
    let plan = get_row(conn, id)?;
    let postings = paid_postings(conn, &plan)?;
    // One cycle past what is owed now, so the page can show what comes next.
    let horizon = today() + Duration::days(cycle_days(&plan.cadence, plan.every) + 2);
    Ok(occurrences_of(&plan, &postings, horizon))
}

/* ----------------------------------------------------------------- linking */

/// Says that these postings belong to this plan.
///
/// A posting backs one plan at most — two plans sharing a payment would each
/// count it, and the month would look paid for twice — so any link a posting
/// already had is replaced.
pub fn link_postings(conn: &Connection, plan_id: &str, ids: &[String]) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    // The plan has to exist before anything is hung off it.
    get_row(conn, plan_id)?;
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let mut linked = 0;
    for id in ids {
        conn.execute("DELETE FROM plan_entries WHERE transaction_id = ?1", params![id])
            .map_err(oops)?;
        linked += conn
            .execute(
                "INSERT INTO plan_entries (plan_id, transaction_id) VALUES (?1, ?2)",
                params![plan_id, id],
            )
            .map_err(oops)? as i64;
    }
    guard.commit().map_err(oops)?;
    Ok(linked)
}

/// Takes a posting back off a plan. The posting itself is untouched — this
/// only says it was not the thing the plan was waiting for.
pub fn unlink_posting(conn: &Connection, plan_id: &str, transaction_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM plan_entries WHERE plan_id = ?1 AND transaction_id = ?2",
        params![plan_id, transaction_id],
    )
    .map_err(oops)?;
    Ok(())
}

/// Which plan each of these postings already backs, by posting id — so a
/// picker can show what is spoken for rather than letting somebody take it
/// off another plan without noticing.
pub fn plans_of_postings(conn: &Connection, ids: &[String]) -> Result<HashMap<String, String>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let holes = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT e.transaction_id, p.name
         FROM plan_entries e JOIN plans p ON p.id = e.plan_id
         WHERE e.transaction_id IN ({holes})"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let mut found = stmt
        .query_map(rusqlite::params_from_iter(ids), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(oops)?;
    let mut out = HashMap::new();
    while let Some(row) = found.next() {
        let (id, name) = row.map_err(oops)?;
        out.insert(id, name);
    }
    Ok(out)
}


/* ------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> NaiveDate {
        parse_day(text).unwrap()
    }

    /// A book on disk, because `db::open` is what brings the schema up and an
    /// in-memory one would need the migration to be public.
    fn book() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("midas-plans-{}.sqlite3", new_id()));
        let conn = db::open(&path).unwrap();
        (conn, path)
    }

    fn seed_account(conn: &Connection) -> String {
        let account = new_id();
        conn.execute(
            "INSERT INTO accounts (id, name, kind, institution, opening_balance, color, icon,
                                   archived, sort_order, created_at, credit_limit)
             VALUES (?1, 'HDFC', 'bank', NULL, 0, '#118ae4', 'wallet', 0, 0, ?2, 0)",
            params![account, now()],
        )
        .unwrap();
        account
    }

    /// One charge in the book, and its id.
    fn charge(
        conn: &Connection,
        account: &str,
        merchant: &str,
        on: NaiveDate,
        amount: Paise,
    ) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO transactions (id, kind, amount, account_id, to_account_id,
                                       category_id, merchant, note, occurred_at, created_at)
             VALUES (?1, 'expense', ?2, ?3, NULL, NULL, ?4, NULL, ?5, ?6)",
            params![id, amount, account, merchant, format!("{on}T09:00"), now()],
        )
        .unwrap();
        id
    }

    fn a_plan(name: &str, merchant: &str, amount: Paise, anchor: NaiveDate) -> PlanInput {
        PlanInput {
            id: None,
            name: name.into(),
            kind: "expense".into(),
            amount,
            account_id: None,
            to_account_id: None,
            category_id: None,
            merchant: merchant.into(),
            note: None,
            cadence: "monthly".into(),
            every: Some(1),
            anchor_on: anchor.to_string(),
            ends_on: None,
            automatic: Some(true),
            variable: Some(false),
            match_key: None,
            archived: Some(false),
        }
    }

    #[test]
    fn a_month_end_plan_keeps_landing_on_month_ends() {
        let anchor = day("2026-01-31");
        assert_eq!(nth_due(anchor, "monthly", 1, 1), day("2026-02-28"));
        // Counted from the anchor rather than from February, so the short
        // month costs the plan nothing.
        assert_eq!(nth_due(anchor, "monthly", 1, 2), day("2026-03-31"));
        assert_eq!(nth_due(anchor, "monthly", 1, 3), day("2026-04-30"));
    }

    #[test]
    fn cadences_come_to_what_they_cost_a_year() {
        assert_eq!(yearly_of(10_000, "monthly", 1), 120_000);
        assert_eq!(yearly_of(10_000, "quarterly", 1), 40_000);
        assert_eq!(yearly_of(10_000, "weekly", 1), 520_000);
        assert_eq!(yearly_of(120_000, "yearly", 1), 120_000);
        // Every second month is half of every month.
        assert_eq!(yearly_of(10_000, "monthly", 2), 60_000);
        assert_eq!(monthly_of(120_000, "yearly", 1), 10_000);
    }

    /// Linking is the whole of it: a plan knows what it has been paid because
    /// somebody said so, and unlinking gives it straight back.
    #[test]
    fn a_plan_counts_what_is_linked_to_it_and_nothing_else() {
        let (conn, path) = book();
        let account = seed_account(&conn);
        let start = add_months(today(), -3);
        let ids: Vec<String> = (0..4)
            .map(|n| charge(&conn, &account, "Netflix", add_months(start, n), 64_900))
            .collect();

        let plan =
            save_plan(&conn, a_plan("Netflix", "Netflix", 64_900, add_months(start, 3))).unwrap();
        // Nothing has been said to belong to it, so nothing does — however
        // plainly the ledger reads.
        assert_eq!(plan.paid_count, 0);
        assert_eq!(plan.observed_total, 0);

        link_postings(&conn, &plan.id, &ids).unwrap();
        let plan = get_plan(&conn, &plan.id).unwrap();
        assert_eq!(plan.paid_count, 4);
        assert_eq!(plan.observed_total, 4 * 64_900);
        assert_eq!(plan.missed, 0);
        assert_eq!(plan.next_due, Some(add_months(start, 4).to_string()));

        unlink_posting(&conn, &plan.id, &ids[0]).unwrap();
        assert_eq!(get_plan(&conn, &plan.id).unwrap().paid_count, 3);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// The whole reason for doing it this way. Apple bills iCloud and Apple
    /// TV under the one name, at prices that could both change tomorrow, and
    /// nothing but the person paying knows which is which.
    #[test]
    fn two_plans_can_share_a_payee_without_sharing_a_penny() {
        let (conn, path) = book();
        let account = seed_account(&conn);
        let start = add_months(today(), -3);

        let mut storage = Vec::new();
        let mut telly = Vec::new();
        for n in 0..4 {
            storage.push(charge(&conn, &account, "Apple", add_months(start, n), 74_900));
            telly.push(charge(
                &conn,
                &account,
                "Apple",
                add_months(start, n) + Duration::days(1),
                9_900,
            ));
        }
        // And a laptop, which belongs to neither.
        charge(&conn, &account, "Apple", start + Duration::days(40), 1_980_000);

        let icloud =
            save_plan(&conn, a_plan("iCloud", "Apple", 74_900, add_months(start, 3))).unwrap();
        let tv = save_plan(
            &conn,
            a_plan("Apple TV", "Apple", 9_900, add_months(start, 3) + Duration::days(1)),
        )
        .unwrap();
        link_postings(&conn, &icloud.id, &storage).unwrap();
        link_postings(&conn, &tv.id, &telly).unwrap();

        let icloud = get_plan(&conn, &icloud.id).unwrap();
        let tv = get_plan(&conn, &tv.id).unwrap();
        assert_eq!(icloud.paid_count, 4);
        assert_eq!(icloud.observed_total, 4 * 74_900);
        assert_eq!(tv.paid_count, 4);
        assert_eq!(tv.observed_total, 4 * 9_900);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// The name is a label and nothing more. It has no bearing on what a plan
    /// is paid by, which is the only thing that could have made renaming one
    /// cost it anything.
    #[test]
    fn renaming_a_plan_changes_nothing_but_the_name() {
        let (conn, path) = book();
        let account = seed_account(&conn);
        let start = add_months(today(), -3);
        let ids: Vec<String> = (0..4)
            .map(|n| charge(&conn, &account, "Adobe", add_months(start, n), 111_100))
            .collect();

        let mut input = a_plan("Adobe", "Adobe", 111_100, add_months(start, 3));
        let plan = save_plan(&conn, input.clone()).unwrap();
        link_postings(&conn, &plan.id, &ids).unwrap();
        assert_eq!(get_plan(&conn, &plan.id).unwrap().paid_count, 4);

        input.id = Some(plan.id.clone());
        input.name = "Adobe Lightroom".into();
        // The payee goes too, and it still makes no difference: nothing is
        // found by either any more.
        input.merchant = "Something else entirely".into();
        let renamed = save_plan(&conn, input).unwrap();
        assert_eq!(renamed.name, "Adobe Lightroom");
        assert_eq!(renamed.paid_count, 4, "the links hold it, not the words");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// A posting backs one plan. Linking it somewhere else moves it rather
    /// than letting two plans each count the same money.
    #[test]
    fn a_posting_can_only_belong_to_one_plan() {
        let (conn, path) = book();
        let account = seed_account(&conn);
        let when = add_months(today(), -1);
        let id = charge(&conn, &account, "Spotify", when, 11_900);

        let first = save_plan(&conn, a_plan("Spotify", "Spotify", 11_900, when)).unwrap();
        let second = save_plan(&conn, a_plan("Spotify family", "Spotify", 11_900, when)).unwrap();
        link_postings(&conn, &first.id, &[id.clone()]).unwrap();
        link_postings(&conn, &second.id, &[id]).unwrap();

        assert_eq!(get_plan(&conn, &first.id).unwrap().paid_count, 0);
        assert_eq!(get_plan(&conn, &second.id).unwrap().paid_count, 1);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// Where a bill was paid from is a fact about the month, not about the
    /// bill: the rent goes out of whichever account had the money in it.
    #[test]
    fn a_payment_from_any_account_counts_once_it_is_linked() {
        let (conn, path) = book();
        let hdfc = seed_account(&conn);
        let indian = seed_account(&conn);
        let start = add_months(today(), -2);
        let ids = vec![
            charge(&conn, &hdfc, "Fauzia Homes", start, 3_800_000),
            charge(&conn, &indian, "Fauzia Homes", add_months(start, 1), 3_800_000),
            charge(&conn, &indian, "Fauzia Homes", add_months(start, 2), 3_800_000),
        ];
        let mut input = a_plan("Rent", "Fauzia Homes", 3_800_000, add_months(start, 2));
        input.account_id = Some(hdfc);
        let plan = save_plan(&conn, input).unwrap();
        link_postings(&conn, &plan.id, &ids).unwrap();

        let plan = get_plan(&conn, &plan.id).unwrap();
        assert_eq!(plan.paid_count, 3);
        assert_eq!(plan.missed, 0);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// A plan with nothing linked to it yet is new, not finished — however
    /// far back its dates go.
    #[test]
    fn a_plan_with_nothing_linked_is_new_rather_than_lapsed() {
        let (conn, path) = book();
        let plan =
            save_plan(&conn, a_plan("Gym", "Gym", 200_000, add_months(today(), -6))).unwrap();
        assert_eq!(plan.paid_count, 0);
        assert!(plan.missed >= 3);
        assert_ne!(plan.status, "lapsed");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// A plan's own page is drawn from its whole life, holes included: the
    /// cycles that were paid, and the ones where nothing happened at all.
    #[test]
    fn the_timeline_keeps_the_cycles_nobody_paid() {
        let (conn, path) = book();
        let account = seed_account(&conn);
        let start = add_months(today(), -4);
        // Four payments across five months — the third was never made.
        let ids: Vec<String> = [0, 1, 3, 4]
            .iter()
            .map(|n| {
                charge(
                    &conn,
                    &account,
                    "Netflix",
                    add_months(start, *n),
                    if *n == 4 { 69_900 } else { 64_900 },
                )
            })
            .collect();
        let plan =
            save_plan(&conn, a_plan("Netflix", "Netflix", 64_900, add_months(start, 4))).unwrap();
        link_postings(&conn, &plan.id, &ids).unwrap();

        let timeline = plan_timeline(&conn, &plan.id).unwrap();
        let paid: Vec<&PlanOccurrence> = timeline.iter().filter(|o| o.paid).collect();
        assert_eq!(paid.len(), 4);
        let hole = timeline
            .iter()
            .find(|o| o.due_on == add_months(start, 2).to_string())
            .expect("the month nobody was billed still had a cycle");
        assert!(!hole.paid && !hole.skipped);
        // Oldest first, and every paid cycle names the posting behind it.
        assert!(timeline.windows(2).all(|w| w[0].due_on <= w[1].due_on));
        assert!(paid.iter().all(|o| o.transaction_id.is_some()));
        // And the rise is readable off the two ends.
        assert_eq!(paid.first().unwrap().actual_amount, 64_900);
        assert_eq!(paid.last().unwrap().actual_amount, 69_900);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// A payment that landed late still belongs to the cycle it was for, and
    /// one payment never fills two cycles.
    #[test]
    fn each_linked_payment_takes_one_cycle_and_the_nearest_free_one() {
        let (conn, path) = book();
        let account = seed_account(&conn);
        let start = add_months(today(), -2);
        let ids = vec![
            charge(&conn, &account, "Netflix", start, 64_900),
            // Four days later than its cycle, and still that cycle's payment.
            charge(&conn, &account, "Netflix", add_months(start, 1) + Duration::days(4), 64_900),
        ];
        let plan = save_plan(&conn, a_plan("Netflix", "Netflix", 64_900, start)).unwrap();
        link_postings(&conn, &plan.id, &ids).unwrap();

        let timeline = plan_timeline(&conn, &plan.id).unwrap();
        assert_eq!(timeline.iter().filter(|o| o.paid).count(), 2);
        assert!(timeline[0].paid && timeline[1].paid);
        assert!(!timeline[2].paid, "two payments do not fill three cycles");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
