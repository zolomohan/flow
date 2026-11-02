//! The tax tab: what you earned, sorted the way a return asks.
//!
//! This module computes **no tax**. That is deliberate and it is the whole
//! design. A liability depends on a regime, a residency, a dozen thresholds
//! that move every budget, and facts the ledger has never been told — and a
//! number produced from a guess at those is worse than no number, because it
//! will be believed. So Midas answers the question it can actually answer:
//! *here is every rupee that came in, here is where it came from, and here is
//! the head you have filed it under.* The arithmetic after that is yours, or
//! your accountant's.
//!
//! Three things shape the code:
//!
//! * **The year is April to March.** Every other tab in Midas reads by the
//!   calendar because that is how spending is lived. Tax is not lived, it is
//!   filed, and it is filed on the financial year — so this tab refuses the
//!   calendar entirely rather than offering both and being misread.
//! * **A tag is a decision, not a derivation.** Nothing infers that
//!   "Freelance" is a professional receipt. You say so once, against the
//!   category, and the tab remembers. What you have not said stays visibly
//!   unsaid: the unfiled pile is a first-class figure, not an "other" bucket
//!   quietly holding half the year.
//! * **Splits are honoured.** Income filed under two categories is two
//!   answers, and reading it through `ATTRIBUTED` means a bill split between
//!   a professional receipt and a reimbursement lands half in each.

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate, Utc};
use rusqlite::{params, Connection};

use crate::db::{attach_parts, oops, tx_from_row, tx_select, Result, ATTRIBUTED, TX_FROM};
use crate::models::*;

/// How many counterparties a head names before it stops. Enough to recognise
/// where the money came from; not so many that the head becomes a ledger.
const SOURCES_PER_HEAD: usize = 6;

/// How many unfiled postings come back with the year. The count is always
/// exact; this caps only the list you can act on without opening the ledger.
const UNFILED_CAP: usize = 300;

fn today() -> NaiveDate {
    Utc::now().date_naive()
}

/// The financial year a date falls in, named by the calendar year it opens
/// in: 15 March 2026 is FY 2025-26, and so returns 2025.
pub fn fy_of(date: NaiveDate) -> i32 {
    if date.month() >= 4 {
        date.year()
    } else {
        date.year() - 1
    }
}

/// 1 April to 31 March, as the strings the ledger compares against. The end
/// carries a time because `occurred_at` does, and a bare date would drop
/// everything posted during the last day of the year.
fn fy_bounds(fy: i32) -> (String, String) {
    (format!("{fy:04}-04-01"), format!("{:04}-03-31T23:59:59", fy + 1))
}

/// April is 0 and March is 11, so a year of figures reads in the order the
/// year is actually lived rather than starting in the middle.
fn fy_slot(month: u32) -> usize {
    ((month + 8) % 12) as usize
}

// ------------------------------------------------------------------ the map

/// Every category that has been given a tax head, as `category_id -> tag`.
pub fn tax_map(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT category_id, tag FROM tax_map").map_err(oops)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(oops)?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(oops)
}

/// Files a category under a head, or — with `None` — puts it back on the pile
/// of things you have not decided about. Un-tagging is a real answer and has
/// to be as easy as tagging, or the map fills with guesses nobody revisits.
pub fn set_tax_tag(conn: &Connection, category_id: &str, tag: Option<String>) -> Result<()> {
    match tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(tag) => conn
            .execute(
                "INSERT INTO tax_map (category_id, tag) VALUES (?1, ?2)
                 ON CONFLICT(category_id) DO UPDATE SET tag = excluded.tag",
                params![category_id, tag],
            )
            .map(|_| ())
            .map_err(oops),
        None => conn
            .execute("DELETE FROM tax_map WHERE category_id = ?1", params![category_id])
            .map(|_| ())
            .map_err(oops),
    }
}

// --------------------------------------------------------------- the totals

/// `tag -> (total, count)` for one side of the book over one window. An
/// untagged category answers to the empty string, which is how the unfiled
/// pile stays a head of its own rather than vanishing into a NULL.
fn totals_by_tag(
    conn: &Connection,
    kind: &str,
    from: &str,
    to: &str,
) -> Result<HashMap<String, (Paise, i64)>> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT COALESCE(m.tag, ''), COALESCE(SUM(att.net_amount), 0),
                COUNT(DISTINCT att.id)
         FROM att
         LEFT JOIN tax_map m ON m.category_id = att.category_id
         WHERE att.kind = ?1 AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0
           AND att.occurred_at >= ?2 AND att.occurred_at <= ?3
         GROUP BY 1"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params![kind, from, to], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, Paise>(1)?, r.get::<_, i64>(2)?)))
        })
        .map_err(oops)?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(oops)
}

/// The categories feeding each tag, largest first within a tag.
fn categories_by_tag(
    conn: &Connection,
    kind: &str,
    from: &str,
    to: &str,
) -> Result<HashMap<String, Vec<TaxSlice>>> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT COALESCE(m.tag, ''), att.category_id, c.name, c.icon, c.color,
                COALESCE(SUM(att.net_amount), 0), COUNT(DISTINCT att.id)
         FROM att
         LEFT JOIN tax_map m ON m.category_id = att.category_id
         LEFT JOIN categories c ON c.id = att.category_id
         WHERE att.kind = ?1 AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0
           AND att.occurred_at >= ?2 AND att.occurred_at <= ?3
         GROUP BY 1, 2
         ORDER BY 6 DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params![kind, from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                TaxSlice {
                    id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    label: r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "Uncategorised".into()),
                    icon: r.get(3)?,
                    color: r.get(4)?,
                    total: r.get(5)?,
                    count: r.get(6)?,
                },
            ))
        })
        .map_err(oops)?;

    let mut out: HashMap<String, Vec<TaxSlice>> = HashMap::new();
    for row in rows {
        let (tag, slice) = row.map_err(oops)?;
        out.entry(tag).or_default().push(slice);
    }
    Ok(out)
}

/// Who the money came from, per tag. Postings with no counterparty recorded
/// are left out rather than collected under a blank name — an unnamed source
/// tells you nothing, and a row saying so tells you less.
fn sources_by_tag(
    conn: &Connection,
    kind: &str,
    from: &str,
    to: &str,
) -> Result<HashMap<String, Vec<TaxSlice>>> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT COALESCE(m.tag, ''), att.merchant,
                COALESCE(SUM(att.net_amount), 0), COUNT(DISTINCT att.id)
         FROM att
         LEFT JOIN tax_map m ON m.category_id = att.category_id
         WHERE att.kind = ?1 AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0 AND att.merchant <> ''
           AND att.occurred_at >= ?2 AND att.occurred_at <= ?3
         GROUP BY 1, 2
         ORDER BY 3 DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params![kind, from, to], |r| {
            let merchant: String = r.get(1)?;
            Ok((
                r.get::<_, String>(0)?,
                TaxSlice {
                    id: merchant.clone(),
                    label: merchant,
                    icon: None,
                    color: None,
                    total: r.get(2)?,
                    count: r.get(3)?,
                },
            ))
        })
        .map_err(oops)?;

    let mut out: HashMap<String, Vec<TaxSlice>> = HashMap::new();
    for row in rows {
        let (tag, slice) = row.map_err(oops)?;
        let bucket = out.entry(tag).or_default();
        if bucket.len() < SOURCES_PER_HEAD {
            bucket.push(slice);
        }
    }
    Ok(out)
}

/// Twelve figures per tag, April first.
fn monthly_by_tag(
    conn: &Connection,
    kind: &str,
    from: &str,
    to: &str,
) -> Result<HashMap<String, Vec<Paise>>> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT COALESCE(m.tag, ''),
                CAST(strftime('%m', att.occurred_at) AS INTEGER),
                COALESCE(SUM(att.net_amount), 0)
         FROM att
         LEFT JOIN tax_map m ON m.category_id = att.category_id
         WHERE att.kind = ?1 AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0
           AND att.occurred_at >= ?2 AND att.occurred_at <= ?3
         GROUP BY 1, 2"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params![kind, from, to], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, r.get::<_, Paise>(2)?))
        })
        .map_err(oops)?;

    let mut out: HashMap<String, Vec<Paise>> = HashMap::new();
    for row in rows {
        let (tag, month, total) = row.map_err(oops)?;
        let series = out.entry(tag).or_insert_with(|| vec![0; 12]);
        if let Some(slot) = series.get_mut(fy_slot(month)) {
            *slot = total;
        }
    }
    Ok(out)
}

/// Assembles one side of the book into heads, largest first, with the unfiled
/// pile pushed to the end however big it is — it is a prompt, not a result.
fn heads_for(
    conn: &Connection,
    kind: &str,
    from: &str,
    to: &str,
    prev: &HashMap<String, (Paise, i64)>,
) -> Result<Vec<TaxHead>> {
    let totals = totals_by_tag(conn, kind, from, to)?;
    let mut categories = categories_by_tag(conn, kind, from, to)?;
    let mut sources = sources_by_tag(conn, kind, from, to)?;
    let mut monthly = monthly_by_tag(conn, kind, from, to)?;

    let mut heads: Vec<TaxHead> = totals
        .into_iter()
        .filter(|(_, (total, count))| *total != 0 || *count != 0)
        .map(|(tag, (total, count))| TaxHead {
            prev_total: prev.get(&tag).map(|(t, _)| *t).unwrap_or(0),
            categories: categories.remove(&tag).unwrap_or_default(),
            sources: sources.remove(&tag).unwrap_or_default(),
            monthly: monthly.remove(&tag).unwrap_or_else(|| vec![0; 12]),
            tag,
            total,
            count,
        })
        .collect();

    heads.sort_by(|a, b| match (a.tag.is_empty(), b.tag.is_empty()) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => b.total.cmp(&a.total),
    });
    Ok(heads)
}

/// Interest as AIS reports it: per account, because that is how a bank files
/// it and therefore how it has to be ticked off.
fn interest_by_account(conn: &Connection, from: &str, to: &str) -> Result<Vec<TaxSlice>> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT att.account_id, a.name, a.icon, a.color,
                COALESCE(SUM(att.net_amount), 0), COUNT(DISTINCT att.id)
         FROM att
         JOIN tax_map m ON m.category_id = att.category_id AND m.tag = 'interest'
         JOIN accounts a ON a.id = att.account_id
         WHERE att.kind = 'income' AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0
           AND att.occurred_at >= ?1 AND att.occurred_at <= ?2
         GROUP BY 1
         ORDER BY 5 DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            Ok(TaxSlice {
                id: r.get(0)?,
                label: r.get(1)?,
                icon: r.get(2)?,
                color: r.get(3)?,
                total: r.get(4)?,
                count: r.get(5)?,
            })
        })
        .map_err(oops)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)
}

/// Income that had landed by a date, counted from 1 April.
fn income_through(conn: &Connection, from: &str, upto: &str) -> Result<Paise> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT COALESCE(SUM(att.net_amount), 0) FROM att
         WHERE att.kind = 'income' AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0
           AND att.occurred_at >= ?1 AND att.occurred_at <= ?2"
    );
    conn.query_row(&sql, params![from, upto], |r| r.get(0)).map_err(oops)
}

/// The four instalment dates, and what had come in by each. Midas stops at
/// the income: the instalment itself is a share of a liability, and the
/// liability is the number this tab will not invent.
fn quarters(conn: &Connection, fy: i32, from: &str) -> Result<Vec<TaxQuarter>> {
    let marks: [(&str, u32, i32, u32, u32); 4] = [
        ("First instalment", 15, 0, 6, 15),
        ("Second instalment", 45, 0, 9, 15),
        ("Third instalment", 75, 0, 12, 15),
        ("Fourth instalment", 100, 1, 3, 15),
    ];
    let now = today();
    let mut out = Vec::with_capacity(4);
    for (label, share, year_offset, month, day) in marks {
        let Some(due) = NaiveDate::from_ymd_opt(fy + year_offset, month, day) else {
            continue;
        };
        let upto = format!("{}T23:59:59", due.format("%Y-%m-%d"));
        out.push(TaxQuarter {
            label: label.to_string(),
            due_on: due.format("%Y-%m-%d").to_string(),
            share,
            income: income_through(conn, from, &upto)?,
            past: due < now,
        });
    }
    Ok(out)
}

/// The unfiled postings themselves. A posting appears here if any part of it
/// landed in a category with no head — a split half-filed is still a decision
/// outstanding, and hiding it until the whole is untagged would lose it.
fn unfiled(conn: &Connection, from: &str, to: &str) -> Result<Vec<Transaction>> {
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         {}{TX_FROM}
         WHERE t.kind = 'income' AND t.refund_of IS NULL AND t.cashback_cycle IS NULL AND t.pays_cashback = 0
           AND t.occurred_at >= ?1 AND t.occurred_at <= ?2
           AND t.id IN (
             SELECT att.id FROM att
             LEFT JOIN tax_map m ON m.category_id = att.category_id
             WHERE m.tag IS NULL AND att.kind = 'income' AND att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0
           )
         ORDER BY t.occurred_at DESC, t.created_at DESC
         LIMIT {UNFILED_CAP}",
        tx_select()
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt.query_map(params![from, to], tx_from_row).map_err(oops)?;
    let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(oops)?;
    attach_parts(conn, &mut rows)?;
    Ok(rows)
}

/// Income categories carrying no head at all — the work outstanding, counted
/// in decisions rather than in postings, because one tag can clear hundreds.
fn untagged_categories(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM categories c
         LEFT JOIN tax_map m ON m.category_id = c.id
         WHERE c.kind = 'income' AND m.tag IS NULL",
        [],
        |r| r.get(0),
    )
    .map_err(oops)
}

// ------------------------------------------------------------------ the year

pub fn tax_year(conn: &Connection, fy: i32) -> Result<TaxYear> {
    let (from, to) = fy_bounds(fy);
    let (prev_from, prev_to) = fy_bounds(fy - 1);

    let prev_income_tags = totals_by_tag(conn, "income", &prev_from, &prev_to)?;
    let prev_expense_tags = totals_by_tag(conn, "expense", &prev_from, &prev_to)?;

    let heads = heads_for(conn, "income", &from, &to, &prev_income_tags)?;
    let deductions: Vec<TaxHead> = heads_for(conn, "expense", &from, &to, &prev_expense_tags)?
        .into_iter()
        // Untagged spending is simply spending. Only what you have marked as
        // mattering to a return belongs on this side of the tab.
        .filter(|h| !h.tag.is_empty())
        .collect();

    let income: Paise = heads.iter().map(|h| h.total).sum();
    let unclassified = heads.iter().find(|h| h.tag.is_empty());
    let unclassified_total = unclassified.map(|h| h.total).unwrap_or(0);
    let unclassified_count = unclassified.map(|h| h.count).unwrap_or(0);

    let ends = NaiveDate::from_ymd_opt(fy + 1, 3, 31).ok_or("Could not resolve that year.")?;

    Ok(TaxYear {
        fy,
        label: format!("FY {fy}-{:02}", (fy + 1) % 100),
        assessment: format!("AY {}-{:02}", fy + 1, (fy + 2) % 100),
        starts_on: from.clone(),
        ends_on: ends.format("%Y-%m-%d").to_string(),
        closed: ends < today(),
        income,
        prev_income: prev_income_tags.values().map(|(t, _)| *t).sum(),
        classified: income - unclassified_total,
        unclassified: unclassified_total,
        unclassified_count,
        heads,
        deductions,
        quarters: quarters(conn, fy, &from)?,
        interest: interest_by_account(conn, &from, &to)?,
        unfiled: unfiled(conn, &from, &to)?,
        untagged_categories: untagged_categories(conn)?,
    })
}

/// Which years the tab can show: every year the book has a posting in, newest
/// first, and always the year we are standing in even if nothing is in it yet.
pub fn tax_years(conn: &Connection) -> Result<Vec<i32>> {
    let span: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT MIN(occurred_at), MAX(occurred_at) FROM transactions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(oops)?;

    let parse = |s: &str| NaiveDate::parse_from_str(&s[..10.min(s.len())], "%Y-%m-%d").ok();
    let here = fy_of(today());
    let first = span.0.as_deref().and_then(parse).map(fy_of).unwrap_or(here);
    let last = span.1.as_deref().and_then(parse).map(fy_of).unwrap_or(here);

    Ok((first.min(here)..=last.max(here)).rev().collect())
}

/// The year as a spreadsheet: one row per posting, with the head it is filed
/// under. This is the artefact you actually hand someone — a tab on a screen
/// is not something an accountant can work from.
pub fn tax_export(conn: &Connection, fy: i32) -> Result<String> {
    let (from, to) = fy_bounds(fy);
    let sql = format!(
        "WITH att AS ({ATTRIBUTED})
         SELECT att.occurred_at, COALESCE(m.tag, ''), COALESCE(c.name, ''),
                att.merchant, a.name, att.net_amount, att.kind
         FROM att
         LEFT JOIN tax_map m ON m.category_id = att.category_id
         LEFT JOIN categories c ON c.id = att.category_id
         JOIN accounts a ON a.id = att.account_id
         WHERE att.refund_of IS NULL AND att.cashback_cycle IS NULL AND att.pays_cashback = 0 AND att.net_amount <> 0
           AND att.occurred_at >= ?1 AND att.occurred_at <= ?2
           AND (att.kind = 'income' OR m.tag IS NOT NULL)
         ORDER BY att.occurred_at"
    );

    fn quote(s: &str) -> String {
        format!("\"{}\"", s.replace('"', "\"\""))
    }

    let mut out = String::from("Date,Head,Category,Counterparty,Account,Amount,Direction\n");
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Paise>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(oops)?;

    for row in rows {
        let (date, tag, category, merchant, account, amount, kind) = row.map_err(oops)?;
        out.push_str(&format!(
            "{},{},{},{},{},{}.{:02},{}\n",
            &date[..10.min(date.len())],
            quote(if tag.is_empty() { "unfiled" } else { &tag }),
            quote(&category),
            quote(&merchant),
            quote(&account),
            amount / 100,
            (amount % 100).abs(),
            kind,
        ));
    }
    Ok(out)
}
