//! Asking the book questions, with Claude.
//!
//! The chat screen sends the conversation so far; Claude answers it by
//! reading the book through a small set of tools, and the answer streams
//! back as `ai-chat-progress` events tagged with the run, the same way the
//! statement reader reports progress.
//!
//! Reading and writing are kept apart. Every lookup works on a connection
//! of its own, opened read-only on the book's file with `query_only` on as
//! well, so SQL Claude writes can never change anything: SQLite refuses it
//! twice over before anything in here has to be right about it, and only a
//! single SELECT (or WITH … SELECT) is let through in the first place.
//!
//! Changes are a separate, fixed set of tools — add, edit, bulk-edit and
//! delete transactions, add a category, pin a label — that call the same
//! functions the app's own sheets do. None of them runs when Claude asks for
//! it: the turn stops, the chat shows each change as a card, and only what
//! the user applies is written, on the app's own connection.
//!
//! Credentials, the model and the request plumbing are the statement
//! reader's: whatever Settings → Claude has connected is what this uses.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai::{self, Credential, FALLBACK_BETA, MODEL};
use crate::db::{self, Db};
use crate::capture;
use crate::models::{CategoryInput, Paise, TransactionInput, TransactionPatch};
use std::collections::HashMap;

type Result<T> = std::result::Result<T, String>;

/// Where the book lives on disk, so the chat can open its own reader on it.
pub struct BookPath(pub PathBuf);

/// The most rows one query hands back. Enough for any table worth reading;
/// a question that needs more should be answered with a GROUP BY.
const MAX_ROWS: usize = 200;
/// A long note or a blob is cut to this many characters in a result.
const MAX_CELL_CHARS: usize = 400;
/// How long one query may run before it is interrupted.
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
/// Round trips to Claude for one question. The last one is told to answer
/// with what it has rather than reach for another tool.
const MAX_STEPS: usize = 14;

/// Runs that have been asked to stop. Checked between steps and while a
/// reply streams in.
static STOPPED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn stop(run: &str) {
    if let Ok(mut s) = STOPPED.lock() {
        s.get_or_insert_with(HashSet::new).insert(run.to_string());
    }
}

fn is_stopped(run: &str) -> bool {
    STOPPED
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|s| s.contains(run)))
        .unwrap_or(false)
}

fn forget_run(run: &str) {
    if let Ok(mut s) = STOPPED.lock() {
        if let Some(s) = s.as_mut() {
            s.remove(run);
        }
    }
}

// ------------------------------------------------------------- the reader

/// A connection that cannot write: opened read-only, and with `query_only`
/// set so that even a statement SQLite would otherwise let through is
/// refused.
pub fn open_reader(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Couldn't open the book to read it: {e}"))?;
    conn.execute_batch("PRAGMA query_only = ON;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// The first word of a statement, past any leading comments.
fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map(|(_, r)| r).unwrap_or("").trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map(|(_, r)| r).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}

/// Whether a `;` outside quotes and comments separates this from more SQL.
fn has_second_statement(sql: &str) -> bool {
    let b = sql.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
            }
            b'[' => {
                while i < b.len() && b[i] != b']' {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b';' => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

/// One SELECT against the book, answered as columns and rows. Anything that
/// is not a single read-only SELECT is turned away with a reason Claude can
/// act on.
pub fn run_select(conn: &Connection, sql: &str) -> Result<Value> {
    let sql = sql.trim().trim_end_matches(';').trim_end();
    if sql.is_empty() {
        return Err("The query is empty.".into());
    }
    let keyword = first_keyword(sql);
    if keyword != "SELECT" && keyword != "WITH" {
        return Err(format!(
            "Only SELECT queries can be run (this one starts with {}). The book is read-only here.",
            if keyword.is_empty() { "something else".to_string() } else { keyword }
        ));
    }
    // SQLite would quietly run only the first of several; say so instead.
    if has_second_statement(sql) {
        return Err("Run one statement at a time.".into());
    }
    let mut stmt = conn.prepare(sql).map_err(|e| match e {
        rusqlite::Error::MultipleStatement => {
            "Run one statement at a time.".to_string()
        }
        e => format!("SQLite couldn't prepare the query: {e}"),
    })?;
    if !stmt.readonly() {
        return Err("That statement would change the book, and the book is read-only here.".into());
    }
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();

    // A runaway query is interrupted rather than left to hold the reader.
    let interrupt = conn.get_interrupt_handle();
    let (done, wait) = mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        if let Err(mpsc::RecvTimeoutError::Timeout) = wait.recv_timeout(QUERY_TIMEOUT) {
            interrupt.interrupt();
        }
    });

    let result = (|| -> Result<(Vec<Value>, bool)> {
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut truncated = false;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if out.len() == MAX_ROWS {
                truncated = true;
                break;
            }
            let mut cells = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                cells.push(cell(row.get_ref(i).map_err(|e| e.to_string())?));
            }
            out.push(Value::Array(cells));
        }
        Ok((out, truncated))
    })();
    let _ = done.send(());
    let _ = watchdog.join();

    let (rows, truncated) = result.map_err(|e| {
        if e.contains("interrupted") {
            format!("The query took longer than {}s and was stopped. Narrow it down.", QUERY_TIMEOUT.as_secs())
        } else {
            format!("SQLite error: {e}")
        }
    })?;
    let mut answer = json!({
        "columns": columns,
        "rows": rows,
        "row_count": rows.len(),
    });
    if truncated {
        answer["truncated"] = json!(format!(
            "Only the first {MAX_ROWS} rows are shown. Aggregate, filter or add a LIMIT."
        ));
    }
    Ok(answer)
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t);
            if s.chars().count() > MAX_CELL_CHARS {
                let cut: String = s.chars().take(MAX_CELL_CHARS).collect();
                json!(format!("{cut}…"))
            } else {
                json!(s)
            }
        }
        ValueRef::Blob(b) => json!(format!("<{} bytes>", b.len())),
    }
}

/// The book's tables as SQLite has them, read fresh so the prompt never
/// describes a schema the migrations have moved past.
fn schema(conn: &Connection) -> Result<String> {
    let mut stmt = conn
        .prepare(
            "SELECT sql FROM sqlite_master
             WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let tables = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(tables.join(";\n\n") + ";")
}

// ------------------------------------------------------------------ tools

fn tools() -> Value {
    let mut all = read_tools();
    all.extend(write_tools());
    Value::Array(all)
}

fn read_tools() -> Vec<Value> {
    let Value::Array(list) = json!([
        {
            "name": "query_book",
            "description": "Run one read-only SQLite SELECT (or WITH … SELECT) against the user's \
                finance book and get the result back as columns and rows. Use it for anything the \
                other tools don't answer directly: spending by category or merchant, transactions in \
                a date range, comparisons between months, debts, holdings, plans. Write aggregate \
                queries rather than pulling raw rows; at most 200 rows come back. Amounts are \
                integer paise. Statements that write are refused.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single SQLite SELECT statement." }
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        },
        {
            "name": "list_accounts",
            "description": "Every account with its current balance as the app computes it \
                (opening balance folded with every posting), its kind, and whether it is archived \
                or a system account. Amounts are integer paise. A credit card's negative balance is \
                what is outstanding on it.",
            "eager_input_streaming": true,
            "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "book_summary",
            "description": "The figures the Overview screen shows for a month: net worth (accounts \
                plus what you are owed and holdings at market value, minus what you owe), liquid \
                money, debt, investments, the month's income and spending with refunds netted, the \
                previous month's, the last twelve months' cash flow, and the top categories and \
                merchants. Use this for net worth and headline figures rather than recomputing \
                them in SQL. Amounts are integer paise.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "month": { "type": "string", "description": "YYYY-MM. Defaults to the current month." }
                },
                "additionalProperties": false
            }
        }
    ]) else {
        unreachable!()
    };
    list
}

/// Runs one tool call against a fresh reader. Errors go back to Claude as
/// an error result rather than ending the conversation.
fn run_tool(book: &Path, name: &str, input: &Value) -> Result<Value> {
    if !input.is_object() {
        return Err("The tool input was not a JSON object.".into());
    }
    let conn = open_reader(book)?;
    match name {
        "query_book" => {
            let sql = input["sql"]
                .as_str()
                .ok_or("query_book needs a `sql` string.")?;
            run_select(&conn, sql)
        }
        "list_accounts" => {
            let accounts = db::list_accounts(&conn)?;
            Ok(json!(accounts
                .iter()
                .map(|a| json!({
                    "id": a.id,
                    "name": a.name,
                    "kind": a.kind,
                    "institution": a.institution,
                    "balance": a.balance,
                    "credit_limit": if a.credit_limit > 0 { json!(a.credit_limit) } else { Value::Null },
                    "archived": a.archived,
                    "system": a.system,
                }))
                .collect::<Vec<_>>()))
        }
        "book_summary" => {
            let month = match input.get("month").and_then(Value::as_str) {
                Some(m) if !m.trim().is_empty() => m.trim().to_string(),
                _ => chrono::Local::now().format("%Y-%m").to_string(),
            };
            let mut v = serde_json::to_value(db::overview(&conn, &month, 1)?)
                .map_err(|e| e.to_string())?;
            // Per-day series are for drawing, not reading.
            if let Some(o) = v.as_object_mut() {
                o.remove("balanceSeries");
                o.remove("dailyFlow");
            }
            Ok(v)
        }
        other => Err(format!("There is no tool called {other}.")),
    }
}

// ----------------------------------------------------------------- writes
//
// Changes go through the same functions the app's own sheets call, so a
// posting Claude adds is checked, labelled and counted exactly like one
// typed in. None of them runs when Claude asks: the turn stops, the chat
// shows each change, and only the ones the user applies are made.

/// What a declined change tells Claude.
const DECLINED: &str = "Declined by the user: nothing was changed. Don't retry it unless they ask.";

fn is_write(name: &str) -> bool {
    matches!(
        name,
        "add_transaction"
            | "edit_transaction"
            | "update_transactions"
            | "delete_transactions"
            | "add_category"
            | "label_transactions"
    )
}

fn write_tools() -> Vec<Value> {
    let note = " The user sees the change and approves or declines it before anything is written; \
                you get back what was done, or that they declined.";
    vec![
        json!({
            "name": "add_transaction",
            "description": format!("Add one transaction to the book.{note} Amount is positive integer paise; \
                kind gives the direction. A transfer needs to_account_id and takes no category. Look up \
                account and category ids first."),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["expense", "income", "transfer"] },
                    "amount": { "type": "integer", "description": "Paise, > 0." },
                    "account_id": { "type": "string" },
                    "to_account_id": { "type": "string", "description": "Transfers only." },
                    "category_id": { "type": "string", "description": "A category of the same kind. Not for transfers." },
                    "merchant": { "type": "string", "description": "Who it was with." },
                    "note": { "type": "string" },
                    "occurred_at": { "type": "string", "description": "YYYY-MM-DD or YYYY-MM-DDTHH:MM." },
                    "label_ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["kind", "amount", "account_id", "merchant", "occurred_at"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "edit_transaction",
            "description": format!("Change one transaction. Only the fields given change; splits, labels and \
                refund links are kept.{note}"),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "kind": { "type": "string", "enum": ["expense", "income", "transfer"] },
                    "amount": { "type": "integer", "description": "Paise, > 0." },
                    "account_id": { "type": "string" },
                    "to_account_id": { "type": "string" },
                    "category_id": { "type": "string" },
                    "merchant": { "type": "string" },
                    "note": { "type": "string" },
                    "occurred_at": { "type": "string" }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "update_transactions",
            "description": format!("One change over many transactions, like the ledger's bulk edit: file them \
                under a category (or take it off), move them to an account, or set the merchant or note. \
                Transactions the change doesn't fit (an expense category on income, a category on a \
                transfer) are skipped.{note}"),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
                    "category_id": { "type": "string" },
                    "clear_category": { "type": "boolean" },
                    "account_id": { "type": "string" },
                    "merchant": { "type": "string" },
                    "note": { "type": "string" },
                    "clear_note": { "type": "boolean" }
                },
                "required": ["ids"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "delete_transactions",
            "description": format!("Delete transactions by id.{note}"),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
                },
                "required": ["ids"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "add_category",
            "description": format!("Create a category, either a top-level group or a sub-category under a \
                group of the same kind.{note}"),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "kind": { "type": "string", "enum": ["expense", "income"] },
                    "parent_id": { "type": "string", "description": "The group to put it under; omit for a new group." }
                },
                "required": ["name", "kind"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "label_transactions",
            "description": format!("Pin a label on transactions, or take it off.{note}"),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
                    "label_id": { "type": "string" },
                    "on": { "type": "boolean", "description": "true to pin, false to take off." }
                },
                "required": ["ids", "label_id", "on"],
                "additionalProperties": false
            }
        }),
    ]
}

fn want_str(input: &Value, key: &str) -> Result<String> {
    input[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("`{key}` is required."))
}

fn opt_str(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn want_amount(input: &Value) -> Result<Option<Paise>> {
    match &input["amount"] {
        Value::Null => Ok(None),
        v => match v.as_i64() {
            Some(n) if n > 0 => Ok(Some(n)),
            _ => Err("`amount` must be a positive whole number of paise.".into()),
        },
    }
}

fn want_ids(input: &Value) -> Result<Vec<String>> {
    let ids: Vec<String> = input["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err("`ids` must list at least one transaction.".into());
    }
    Ok(ids)
}

fn want_kind(kind: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&kind) {
        Ok(())
    } else {
        Err(format!("`kind` must be one of {}.", allowed.join(", ")))
    }
}

/// Rupees the way the app writes them: ₹1,23,456.50, paise only when there are some.
pub(crate) fn inr(paise: Paise) -> String {
    let neg = paise < 0;
    let p = paise.unsigned_abs();
    let (rupees, rest) = (p / 100, p % 100);
    let digits = rupees.to_string();
    let grouped = if digits.len() <= 3 {
        digits
    } else {
        let (head, last3) = digits.split_at(digits.len() - 3);
        let mut parts: Vec<String> = Vec::new();
        let mut h = head.to_string();
        while h.len() > 2 {
            parts.insert(0, h[h.len() - 2..].to_string());
            h.truncate(h.len() - 2);
        }
        if !h.is_empty() {
            parts.insert(0, h);
        }
        format!("{},{}", parts.join(","), last3)
    };
    let sign = if neg { "−" } else { "" };
    if rest == 0 {
        format!("{sign}₹{grouped}")
    } else {
        format!("{sign}₹{grouped}.{rest:02}")
    }
}

fn name_of(conn: &Connection, table: &str, id: &str) -> String {
    conn.query_row(&format!("SELECT name FROM {table} WHERE id = ?1"), [id], |r| r.get::<_, String>(0))
        .unwrap_or_else(|_| format!("unknown ({id})"))
}

fn category_label(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' › ' || c.name END
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| format!("unknown category ({id})"))
}

/// One posting in a line: the day, who with, how much.
fn posting_line(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT substr(occurred_at, 1, 10), merchant, amount, kind FROM transactions WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)),
    )
    .map(|(day, merchant, amount, kind)| {
        let who = if merchant.is_empty() { "(no merchant)".to_string() } else { merchant };
        format!("{day} · {who} · {} {kind}", inr(amount))
    })
    .unwrap_or_else(|_| format!("A transaction that doesn't exist ({id})"))
}

fn postings_lines(conn: &Connection, ids: &[String]) -> Vec<String> {
    const SHOWN: usize = 8;
    let mut lines: Vec<String> = ids.iter().take(SHOWN).map(|id| posting_line(conn, id)).collect();
    if ids.len() > SHOWN {
        lines.push(format!("and {} more", ids.len() - SHOWN));
    }
    lines
}

fn plural(n: usize, one: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") }
}

/// A change put the way the confirm card shows it: a title and its detail.
/// Read from the book, so ids become names; it checks only what it needs to
/// say, and the save itself checks the rest.
fn describe_change(conn: &Connection, name: &str, input: &Value) -> Result<(String, Vec<String>)> {
    if !input.is_object() {
        return Err("The change didn't come through in a form that can be read.".into());
    }
    match name {
        "add_transaction" => {
            let kind = want_str(input, "kind")?;
            let amount = want_amount(input)?.ok_or("`amount` is required.")?;
            let account = want_str(input, "account_id")?;
            let mut lines = vec![];
            let merchant = opt_str(input, "merchant").unwrap_or_default();
            if !merchant.is_empty() {
                lines.push(merchant);
            }
            if kind == "transfer" {
                let to = opt_str(input, "to_account_id").map(|t| name_of(conn, "accounts", &t));
                lines.push(format!("{} → {}", name_of(conn, "accounts", &account), to.unwrap_or_else(|| "?".into())));
            } else {
                lines.push(name_of(conn, "accounts", &account));
                lines.push(
                    opt_str(input, "category_id")
                        .map(|c| category_label(conn, &c))
                        .unwrap_or_else(|| "No category".into()),
                );
            }
            lines.push(opt_str(input, "occurred_at").unwrap_or_default());
            if let Some(n) = opt_str(input, "note") {
                lines.push(format!("Note: {n}"));
            }
            Ok((format!("Add {} {kind}", inr(amount)), lines))
        }
        "edit_transaction" => {
            let id = want_str(input, "id")?;
            let mut lines = vec![posting_line(conn, &id)];
            if let Some(k) = opt_str(input, "kind") {
                lines.push(format!("Kind → {k}"));
            }
            if let Some(a) = want_amount(input)? {
                lines.push(format!("Amount → {}", inr(a)));
            }
            if let Some(a) = opt_str(input, "account_id") {
                lines.push(format!("Account → {}", name_of(conn, "accounts", &a)));
            }
            if let Some(a) = opt_str(input, "to_account_id") {
                lines.push(format!("To account → {}", name_of(conn, "accounts", &a)));
            }
            if let Some(c) = opt_str(input, "category_id") {
                lines.push(format!("Category → {}", category_label(conn, &c)));
            }
            if let Some(m) = opt_str(input, "merchant") {
                lines.push(format!("Merchant → {m}"));
            }
            if let Some(n) = input["note"].as_str() {
                lines.push(format!("Note → {n}"));
            }
            if let Some(d) = opt_str(input, "occurred_at") {
                lines.push(format!("Date → {d}"));
            }
            Ok(("Edit a transaction".into(), lines))
        }
        "update_transactions" => {
            let ids = want_ids(input)?;
            let mut what = vec![];
            if input["clear_category"].as_bool() == Some(true) {
                what.push("take the category off".to_string());
            } else if let Some(c) = opt_str(input, "category_id") {
                what.push(format!("file under {}", category_label(conn, &c)));
            }
            if let Some(a) = opt_str(input, "account_id") {
                what.push(format!("move to {}", name_of(conn, "accounts", &a)));
            }
            if let Some(m) = opt_str(input, "merchant") {
                what.push(format!("set merchant to “{m}”"));
            }
            if input["clear_note"].as_bool() == Some(true) {
                what.push("clear the note".into());
            } else if let Some(n) = opt_str(input, "note") {
                what.push(format!("set note to “{n}”"));
            }
            if what.is_empty() {
                return Err("The change doesn't say what to change.".into());
            }
            let mut title = what.join(", ");
            title.replace_range(..1, &title[..1].to_uppercase());
            Ok((format!("{title} · {}", plural(ids.len(), "transaction")), postings_lines(conn, &ids)))
        }
        "delete_transactions" => {
            let ids = want_ids(input)?;
            Ok((format!("Delete {}", plural(ids.len(), "transaction")), postings_lines(conn, &ids)))
        }
        "add_category" => {
            let name = want_str(input, "name")?;
            let kind = want_str(input, "kind")?;
            let under = opt_str(input, "parent_id").map(|p| format!("Under {}", name_of(conn, "categories", &p)));
            Ok((
                format!("Add {kind} category “{name}”"),
                vec![under.unwrap_or_else(|| "As a new group".into())],
            ))
        }
        "label_transactions" => {
            let ids = want_ids(input)?;
            let label = name_of(conn, "labels", &want_str(input, "label_id")?);
            let on = input["on"].as_bool().unwrap_or(true);
            Ok((
                if on {
                    format!("Label {} “{label}”", plural(ids.len(), "transaction"))
                } else {
                    format!("Take “{label}” off {}", plural(ids.len(), "transaction"))
                },
                postings_lines(conn, &ids),
            ))
        }
        other => Err(format!("There is no change called {other}.")),
    }
}

/// Makes one approved change on the app's own connection, and says what
/// happened in words the history can show.
fn apply_change(conn: &Connection, name: &str, input: &Value) -> Result<Value> {
    let (title, _) = describe_change(conn, name, input)?;
    let result = match name {
        "add_transaction" => {
            let kind = want_str(input, "kind")?;
            want_kind(&kind, &["expense", "income", "transfer"])?;
            let saved = db::save_transaction(
                conn,
                TransactionInput {
                    id: None,
                    amount: want_amount(input)?.ok_or("`amount` is required.")?,
                    account_id: want_str(input, "account_id")?,
                    to_account_id: if kind == "transfer" { opt_str(input, "to_account_id") } else { None },
                    category_id: if kind == "transfer" { None } else { opt_str(input, "category_id") },
                    merchant: opt_str(input, "merchant").unwrap_or_default(),
                    note: opt_str(input, "note"),
                    occurred_at: want_str(input, "occurred_at")?,
                    splits: None,
                    shares: None,
                    label_ids: input["label_ids"].as_array().map(|a| {
                        a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                    }),
                    refund_of: None,
                    cashback: None,
                    kind,
                },
            )?;
            json!({ "done": title, "id": saved.id })
        }
        "edit_transaction" => {
            let id = want_str(input, "id")?;
            let was = db::get_transaction(conn, &id)?;
            let kind = opt_str(input, "kind").unwrap_or(was.kind.clone());
            want_kind(&kind, &["expense", "income", "transfer"])?;
            let transfer = kind == "transfer";
            let saved = db::save_transaction(
                conn,
                TransactionInput {
                    id: Some(id),
                    amount: want_amount(input)?.unwrap_or(was.amount),
                    account_id: opt_str(input, "account_id").unwrap_or(was.account_id),
                    to_account_id: if transfer {
                        opt_str(input, "to_account_id").or(was.to_account_id)
                    } else {
                        None
                    },
                    category_id: if transfer {
                        None
                    } else {
                        opt_str(input, "category_id").or(was.category_id)
                    },
                    merchant: input["merchant"].as_str().map(|m| m.trim().to_string()).unwrap_or(was.merchant),
                    note: match input["note"].as_str() {
                        Some(n) if n.trim().is_empty() => None,
                        Some(n) => Some(n.trim().to_string()),
                        None => was.note,
                    },
                    occurred_at: opt_str(input, "occurred_at").unwrap_or(was.occurred_at),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: was.refund_of,
                    cashback: was.cashback_set,
                    kind,
                },
            )?;
            json!({ "done": title, "id": saved.id })
        }
        "update_transactions" => {
            let ids = want_ids(input)?;
            let r = db::update_transactions(
                conn,
                &ids,
                TransactionPatch {
                    category_id: opt_str(input, "category_id"),
                    clear_category: input["clear_category"].as_bool(),
                    account_id: opt_str(input, "account_id"),
                    merchant: opt_str(input, "merchant"),
                    note: opt_str(input, "note"),
                    clear_note: input["clear_note"].as_bool(),
                },
            )?;
            json!({ "done": title, "changed": r.changed, "skipped": r.skipped })
        }
        "delete_transactions" => {
            let ids = want_ids(input)?;
            let n = db::delete_transactions(conn, &ids)?;
            json!({ "done": title, "deleted": n })
        }
        "add_category" => {
            let kind = want_str(input, "kind")?;
            want_kind(&kind, &["expense", "income"])?;
            let parent = opt_str(input, "parent_id");
            // A sub-category dresses like its group until someone says otherwise.
            let (icon, color) = parent
                .as_deref()
                .and_then(|p| {
                    conn.query_row("SELECT icon, color FROM categories WHERE id = ?1", [p], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })
                    .ok()
                })
                .unwrap_or_else(|| ("tag".into(), "#676B89".into()));
            let saved = db::save_category(
                conn,
                CategoryInput { id: None, kind, name: want_str(input, "name")?, icon, color, parent_id: parent },
            )?;
            json!({ "done": title, "id": saved.id })
        }
        "label_transactions" => {
            let ids = want_ids(input)?;
            let n = db::label_transactions(
                conn,
                &ids,
                &want_str(input, "label_id")?,
                input["on"].as_bool().unwrap_or(true),
            )?;
            json!({ "done": title, "changed": n })
        }
        other => return Err(format!("There is no change called {other}.")),
    };
    // The phone's word list is written from accounts and categories.
    let _ = capture::write_book(conn);
    Ok(result)
}

/// A change waiting on the user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    /// The tool call's id, which the answer is keyed by.
    pub id: String,
    pub tool: String,
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub messages: Vec<Value>,
    /// Changes Claude has asked to make. When there are any, the
    /// conversation ends on Claude's turn and waits for the user's answer.
    pub pending: Vec<PendingChange>,
}

// ----------------------------------------------------------------- prompt

fn system_prompt(schema: &str) -> String {
    format!(
        r#"You are the assistant inside flow, a personal finance app that keeps its book in a local SQLite database on the user's Mac. The user asks about their own money — spending, income, categories, accounts, cards, debts, investments, plans — and you answer from the book using your tools.

You can also change the book, but only with the change tools (add_transaction, edit_transaction, update_transactions, delete_transactions, add_category, label_transactions) and only when the user asks for a change. Each change is shown to the user, who applies or declines it; nothing is written until they do. Before proposing one, look up the exact ids you need and check you have the right transactions — for a bulk change, query them first and say how many there are. Prefer one bulk change over many single ones. The bulk edit won't file transactions under a group that has sub-categories; pick one of its sub-categories. Never change anything the user didn't ask to change, and if what they want is ambiguous, ask first. Your SQL is always read-only; changes only ever go through those tools.

## How the book works

- Money is INTEGER paise everywhere: divide by 100 for rupees. The currency is INR. Write amounts as ₹ with Indian digit grouping (₹1,23,456), dropping paise unless they matter; use lakh/crore for very large figures if it reads better.
- `transactions.kind` is 'income', 'expense' or 'transfer'. `amount` is always positive; the kind gives the direction. A transfer moves money from `account_id` to `to_account_id` between the user's own accounts: it is neither income nor spending, and has no category.
- Dates: `occurred_at` is text, 'YYYY-MM-DD' optionally followed by 'THH:MM[:SS]'. Compare with string ranges, e.g. `occurred_at >= '2026-10-01' AND occurred_at < '2026-11-01'`, or group by `substr(occurred_at, 1, 7)`.
- Refunds: a transaction with `refund_of` set gives money back on the transaction it names. Spending and income are counted net of refunds, and the refund itself is not counted as income. The app's own formula for a month's spending is:
  `SELECT SUM(t.amount - COALESCE((SELECT SUM(r.amount) FROM transactions r WHERE r.refund_of = t.id), 0)) FROM transactions t WHERE t.kind = 'expense' AND t.refund_of IS NULL AND <date range>`
  and income the same with kind = 'income'.
- Split bills: `transaction_splits` divides one transaction across categories; the parts add up to the whole. For spending by category, use each split's category when the transaction has splits and the transaction's own category otherwise. The app's attribution, which also nets refunds off the splits, is:
  ```
  WITH attributed AS (
    SELECT t.id, t.kind, t.occurred_at, t.merchant, t.refund_of, t.account_id,
           COALESCE(s.category_id, t.category_id) AS category_id,
           CASE
             WHEN COALESCE(rb.given_back, 0) = 0 THEN COALESCE(s.amount, t.amount)
             WHEN s.id IS NULL THEN t.amount - rb.given_back
             ELSE MAX(0, MIN(s.amount, SUM(s.amount) OVER (PARTITION BY s.transaction_id ORDER BY s.sort_order, s.id) - rb.given_back))
           END AS net_amount
    FROM transactions t
    LEFT JOIN transaction_splits s ON s.transaction_id = t.id
    LEFT JOIN (SELECT refund_of, SUM(amount) AS given_back FROM transactions WHERE refund_of IS NOT NULL GROUP BY refund_of) rb ON rb.refund_of = t.id
  )
  SELECT ... FROM attributed WHERE kind = 'expense' AND refund_of IS NULL ...
  ```
- Categories nest one level: a category with `parent_id` is a sub-category of that group. To roll up to groups, use `COALESCE(parent.id, c.id)` / `COALESCE(parent.name, c.name)`. Categories have a `kind` (income or expense).
- Accounts: kind is bank, credit, cash, wallet or investment. A credit card's balance is negative while money is owed on it. Archived accounts don't count toward net worth. "Lent & borrowed" is a system account that is always archived; debts are counted through the `debts` tables instead. Use `list_accounts` for balances and `book_summary` for net worth instead of rebuilding them.
- Debts: `debts.direction` is 'lent' or 'borrowed'; outstanding is principal plus `debt_additions` minus `debt_payments`, and a debt with `settled_at` is closed.
- Labels (`labels`, `transaction_labels`) and folders (`folders`, `folder_transactions`) group transactions; `plans` are recurring bills and income; `holdings` and `investment_lots` are mutual funds, gold and deposits (quantities ×10⁴ in `*_e4` columns).
- `merchant` is free text and may be spelled inconsistently; match with LIKE and lower() when searching for one.

## How to answer

- Look before you answer: never guess a figure. Use as many queries as you need, and check a surprising number before reporting it.
- Lead with the answer in a sentence, then the supporting detail. Keep it short. Use a small markdown table when comparing several rows; otherwise prose or a short list.
- Say which period a figure covers. When the user says "this month" or "last month", use the dates below. If a question is ambiguous, pick the most likely reading and say which you used.
- Mention it when a result could mislead, for example when uncategorised spending is large or the book has no data for the period asked about.
- Don't show SQL unless the user asks for it.

## The schema

```sql
{schema}
```"#
    )
}

// ----------------------------------------------------------------- the loop

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatProgress<'a> {
    run: &'a str,
    /// text | tool | tool_done | step
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<usize>,
}

impl<'a> ChatProgress<'a> {
    fn new(run: &'a str, kind: &'a str) -> Self {
        Self { run, kind, text: None, tool: None, input: None, error: None, rows: None }
    }
}

type Call = (String, String, Value);

fn calls_in(content: &[Value]) -> Vec<Call> {
    content
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| {
            (
                b["id"].as_str().unwrap_or_default().to_string(),
                b["name"].as_str().unwrap_or_default().to_string(),
                b["input"].clone(),
            )
        })
        .collect()
}

/// Answers every call of one turn, in order, as the single message that
/// follows it. Lookups run on a reader; a change runs on the app's own
/// connection only when `decisions` says the user applied it.
async fn answer_calls(
    app: &AppHandle,
    run: &str,
    book: &Path,
    calls: Vec<Call>,
    decisions: &HashMap<String, bool>,
) -> Result<Value> {
    let mut results = Vec::with_capacity(calls.len());
    let mut wrote = false;
    for (id, name, input) in calls {
        let write = is_write(&name);
        let outcome = if write && decisions.get(&id) != Some(&true) {
            Ok(json!({ "declined": DECLINED }))
        } else {
            let book = book.to_path_buf();
            let app = app.clone();
            let name = name.clone();
            let input = input.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if write {
                    let db = app.state::<Db>();
                    let conn = db.0.lock().map_err(|e| e.to_string())?;
                    apply_change(&conn, &name, &input)
                } else {
                    run_tool(&book, &name, &input)
                }
            })
            .await
            .map_err(|e| e.to_string())?
        };
        let mut done = ChatProgress::new(run, "tool_done");
        done.tool = Some(&name);
        match &outcome {
            Ok(v) => {
                if write && v.get("done").is_some() {
                    wrote = true;
                }
                done.rows = v["row_count"].as_u64().map(|n| n as usize).or_else(|| v.as_array().map(Vec::len));
                let _ = app.emit("ai-chat-progress", &done);
                let content = match v.get("declined").and_then(Value::as_str) {
                    Some(d) => d.to_string(),
                    None => v.to_string(),
                };
                results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": content }));
            }
            Err(e) => {
                done.error = Some(e);
                let _ = app.emit("ai-chat-progress", &done);
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": e,
                    "is_error": true,
                }));
            }
        }
    }
    if wrote {
        // Every screen reading the book refreshes.
        let _ = app.emit("book-changed", ());
    }
    Ok(json!({ "role": "user", "content": results }))
}

/// Carries a conversation forward and hands it back with Claude's turns
/// appended. It either ends on a user's question, which is answered, or on
/// a turn of Claude's that asked for changes, which `decisions` (tool call
/// id → applied) settles before going on.
///
/// The messages are the API's own, thinking blocks and all: they go back to
/// Claude unchanged, which is what lets it carry its reasoning forward.
pub async fn ask(
    app: AppHandle,
    run: String,
    book: PathBuf,
    mut messages: Vec<Value>,
    decisions: HashMap<String, bool>,
) -> Result<ChatReply> {
    forget_run(&run);
    let waiting: Vec<Call> = match messages.last() {
        Some(m) if m["role"] == "user" => vec![],
        Some(m) if m["role"] == "assistant" => {
            let calls = m["content"].as_array().map(|c| calls_in(c)).unwrap_or_default();
            if calls.is_empty() {
                return Err("Ask a question first.".into());
            }
            calls
        }
        _ => return Err("Ask a question first.".into()),
    };
    let (cred, schema) = {
        let book = book.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(Credential, String)> {
            let cred = ai::credential()?;
            let conn = open_reader(&book)?;
            Ok((cred, schema(&conn)?))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let client = ai::client(Duration::from_secs(10 * 60))?;
    let system = system_prompt(&schema);
    let today = chrono::Local::now();
    let dated = format!(
        "Today is {} ({}). The current month is {}.",
        today.format("%Y-%m-%d"),
        today.format("%A"),
        today.format("%Y-%m"),
    );
    let tools = tools();

    let result = async {
        if !waiting.is_empty() {
            let answered = answer_calls(&app, &run, &book, waiting, &decisions).await?;
            messages.push(answered);
        }
        for step in 0..MAX_STEPS {
            if is_stopped(&run) {
                return Err("Stopped.".to_string());
            }
            let last = step + 1 == MAX_STEPS;
            let mut body = json!({
                "model": MODEL,
                "max_tokens": 32000,
                "stream": true,
                "fallbacks": "default",
                "thinking": { "type": "adaptive" },
                "output_config": { "effort": "medium" },
                // The conversation so far is cached as it grows, so each
                // round trip only pays in full for what is new.
                "cache_control": { "type": "ephemeral" },
                "system": [
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": { "type": "ephemeral" },
                    },
                    { "type": "text", "text": dated },
                ],
                "tools": tools,
                "messages": messages,
            });
            if last {
                // Out of steps: answer with what has been found.
                body["tool_choice"] = json!({ "type": "none" });
            }
            let _ = app.emit("ai-chat-progress", ChatProgress::new(&run, "step"));
            let reply = stream_message(&client, &cred, &body, &app, &run).await?;

            match reply.stop_reason.as_deref() {
                Some("refusal") => {
                    return Err("Claude declined to answer that. Try asking it another way.".into())
                }
                Some("max_tokens") if reply.has_tool_use() => {
                    return Err("Claude's reply ran too long to finish. Try a narrower question.".into())
                }
                _ => {}
            }

            let content = echoable(reply.content);
            let calls = calls_in(&content);
            messages.push(json!({ "role": "assistant", "content": content }));

            if calls.is_empty() || reply.stop_reason.as_deref() != Some("tool_use") {
                return Ok(vec![]);
            }

            // A turn that asks for changes waits for the user, lookups and
            // all: the whole turn is answered together when they have.
            if calls.iter().any(|(_, name, _)| is_write(name)) {
                let book = book.clone();
                let asked: Vec<Call> = calls.into_iter().filter(|(_, n, _)| is_write(n)).collect();
                let pending = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<PendingChange>> {
                    let conn = open_reader(&book)?;
                    Ok(asked
                        .into_iter()
                        .map(|(id, tool, input)| {
                            let (title, lines) = describe_change(&conn, &tool, &input).unwrap_or_else(|e| {
                                ("A change that can't be shown".into(), vec![e])
                            });
                            PendingChange { id, tool, title, lines }
                        })
                        .collect())
                })
                .await
                .map_err(|e| e.to_string())??;
                return Ok(pending);
            }

            let answered = answer_calls(&app, &run, &book, calls, &HashMap::new()).await?;
            messages.push(answered);
        }
        Ok(vec![])
    }
    .await;
    forget_run(&run);
    result.map(|pending| ChatReply { messages, pending })
}

/// After a mid-reply fallback, the blocks the declined model produced before
/// the switch are not part of the conversation any more: thinking and tool
/// calls before the last `fallback` block are left out, and the block itself
/// stays where it was.
fn echoable(content: Vec<Value>) -> Vec<Value> {
    let Some(boundary) = content.iter().rposition(|b| b["type"] == "fallback") else {
        return content;
    };
    content
        .into_iter()
        .enumerate()
        .filter(|(i, b)| {
            *i >= boundary
                || matches!(b["type"].as_str(), Some("text"))
        })
        .map(|(_, b)| b)
        .collect()
}

// -------------------------------------------------------------- streaming

struct Reply {
    content: Vec<Value>,
    stop_reason: Option<String>,
}

impl Reply {
    fn has_tool_use(&self) -> bool {
        self.content.iter().any(|b| b["type"] == "tool_use")
    }
}

/// A streamed message put back together block by block: text, thinking and
/// its signature, and each tool call's input from its JSON fragments.
#[derive(Default)]
struct SseMessage {
    blocks: Vec<Value>,
    /// Tool input as it arrives, by block index.
    partial: Vec<String>,
    stop_reason: Option<String>,
}

enum Fed {
    Nothing,
    Text(String),
    ToolStarted(usize),
    ToolFinished(usize),
}

impl SseMessage {
    fn slot(&mut self, i: usize) {
        if self.blocks.len() <= i {
            self.blocks.resize(i + 1, Value::Null);
            self.partial.resize(i + 1, String::new());
        }
    }

    fn feed(&mut self, event: &str) -> Result<Fed> {
        let data: String = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(Fed::Nothing);
        }
        let v: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let i = v["index"].as_u64().unwrap_or(0) as usize;
        match v["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                self.slot(i);
                self.blocks[i] = v["content_block"].clone();
                if v["content_block"]["type"] == "tool_use" {
                    return Ok(Fed::ToolStarted(i));
                }
            }
            "content_block_delta" => {
                self.slot(i);
                let d = &v["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = d["text"].as_str().unwrap_or("");
                        append(&mut self.blocks[i], "text", t);
                        return Ok(Fed::Text(t.to_string()));
                    }
                    "thinking_delta" => {
                        append(&mut self.blocks[i], "thinking", d["thinking"].as_str().unwrap_or(""));
                    }
                    "signature_delta" => {
                        self.blocks[i]["signature"] = d["signature"].clone();
                    }
                    "input_json_delta" => {
                        self.partial[i].push_str(d["partial_json"].as_str().unwrap_or(""));
                    }
                    "citations_delta" => {
                        if let Some(list) = self.blocks[i]
                            .as_object_mut()
                            .map(|o| o.entry("citations").or_insert_with(|| json!([])))
                            .and_then(Value::as_array_mut)
                        {
                            list.push(d["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                self.slot(i);
                if self.blocks[i]["type"] == "tool_use" {
                    let raw = std::mem::take(&mut self.partial[i]);
                    // Streamed eagerly, the input is not checked by the API:
                    // what doesn't parse is handed back as-is, and the tool
                    // turns it away with an error Claude can correct.
                    let input = if raw.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw))
                    };
                    self.blocks[i]["input"] = input;
                    return Ok(Fed::ToolFinished(i));
                }
            }
            "message_delta" => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(r.into());
                }
            }
            "error" => {
                let message = v["error"]["message"].as_str().unwrap_or("unknown error");
                return Err(match v["error"]["type"].as_str() {
                    Some("overloaded_error") => {
                        "Claude is overloaded right now. Try again in a minute.".into()
                    }
                    _ => format!("Claude stopped with an error: {message}"),
                });
            }
            _ => {}
        }
        Ok(Fed::Nothing)
    }

    fn finish(self) -> Reply {
        Reply {
            content: self.blocks.into_iter().filter(|b| !b.is_null()).collect(),
            stop_reason: self.stop_reason,
        }
    }
}

fn append(block: &mut Value, field: &str, more: &str) {
    let was = block[field].as_str().unwrap_or("").to_string();
    block[field] = Value::String(was + more);
}

async fn stream_message(
    client: &reqwest::Client,
    cred: &Credential,
    body: &Value,
    app: &AppHandle,
    run: &str,
) -> Result<Reply> {
    let send = |body: &Value, betas: &[&str]| {
        ai::request(client, reqwest::Method::POST, "/v1/messages", cred, betas)
            .json(body)
            .send()
    };
    let mut resp = send(body, &[FALLBACK_BETA])
        .await
        .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        // Server-side fallbacks are a beta; without them, ask anyway.
        let err = ai::api_error(resp).await;
        if !err.to_lowercase().contains("fallback") {
            return Err(err);
        }
        let mut plain = body.clone();
        if let Some(obj) = plain.as_object_mut() {
            obj.remove("fallbacks");
        }
        resp = send(&plain, &[])
            .await
            .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
    }
    if !resp.status().is_success() {
        return Err(ai::api_error(resp).await);
    }

    let mut msg = SseMessage::default();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The connection dropped: {e}"))? {
        if is_stopped(run) {
            return Err("Stopped.".into());
        }
        buf.extend_from_slice(&chunk);
        while let Some(end) = ai::find_event_end(&buf) {
            let event: Vec<u8> = buf.drain(..end.1).collect();
            let event = String::from_utf8_lossy(&event[..end.0]);
            match msg.feed(&event)? {
                Fed::Text(t) => {
                    let mut p = ChatProgress::new(run, "text");
                    p.text = Some(&t);
                    let _ = app.emit("ai-chat-progress", p);
                }
                Fed::ToolStarted(i) => {
                    let name = msg.blocks[i]["name"].as_str().unwrap_or("").to_string();
                    let mut p = ChatProgress::new(run, "tool");
                    p.tool = Some(&name);
                    let _ = app.emit("ai-chat-progress", p);
                }
                Fed::ToolFinished(i) => {
                    let name = msg.blocks[i]["name"].as_str().unwrap_or("").to_string();
                    let input = msg.blocks[i]["input"].clone();
                    let mut p = ChatProgress::new(run, "tool");
                    p.tool = Some(&name);
                    p.input = Some(&input);
                    let _ = app.emit("ai-chat-progress", p);
                }
                Fed::Nothing => {}
            }
        }
    }
    Ok(msg.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> (tempfile_free::Dir, PathBuf) {
        let dir = tempfile_free::Dir::new();
        let path = dir.0.join("book.sqlite3");
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id, name, kind, opening_balance, color, icon, created_at)
             VALUES ('a', 'Bank', 'bank', 100000, '#000', 'x', '2026-01-01');
             INSERT INTO transactions (id, kind, amount, account_id, merchant, occurred_at, created_at)
             VALUES ('t1', 'expense', 25000, 'a', 'Cafe', '2026-10-02', '2026-10-02'),
                    ('t2', 'expense', 5000,  'a', 'Shop', '2026-10-03', '2026-10-03');",
        )
        .unwrap();
        (dir, path)
    }

    /// A scratch folder without pulling in a crate for it.
    mod tempfile_free {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!("flow-chat-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn selects_are_answered() {
        let (_d, path) = book();
        let conn = open_reader(&path).unwrap();
        let v = run_select(&conn, "SELECT merchant, amount FROM transactions ORDER BY amount DESC;").unwrap();
        assert_eq!(v["columns"], json!(["merchant", "amount"]));
        assert_eq!(v["rows"][0], json!(["Cafe", 25000]));
        assert_eq!(v["row_count"], 2);
        let v = run_select(&conn, "-- total\nWITH x AS (SELECT amount FROM transactions) SELECT SUM(amount) FROM x").unwrap();
        assert_eq!(v["rows"][0][0], 30000);
    }

    #[test]
    fn nothing_that_writes_gets_through() {
        let (_d, path) = book();
        let conn = open_reader(&path).unwrap();
        for sql in [
            "DELETE FROM transactions",
            "UPDATE transactions SET amount = 1",
            "INSERT INTO accounts (id) VALUES ('x')",
            "DROP TABLE transactions",
            "PRAGMA query_only = OFF",
            "ATTACH DATABASE '/tmp/x.db' AS x",
            "/* sneaky */ DELETE FROM transactions",
            "SELECT 1; DELETE FROM transactions",
            "WITH x AS (SELECT 1) DELETE FROM transactions",
            "WITH x AS (SELECT 1) INSERT INTO labels (id, name, color, created_at) VALUES ('l','l','c','n')",
        ] {
            assert!(run_select(&conn, sql).is_err(), "{sql} got through");
        }
        // Even the raw connection refuses.
        assert!(conn.execute("DELETE FROM transactions", []).is_err());
        let still = run_select(&conn, "SELECT COUNT(*) FROM transactions").unwrap();
        assert_eq!(still["rows"][0][0], 2);
    }

    #[test]
    fn long_results_are_cut() {
        let (_d, path) = book();
        let conn = open_reader(&path).unwrap();
        let v = run_select(
            &conn,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) SELECT i FROM n",
        )
        .unwrap();
        assert_eq!(v["row_count"], MAX_ROWS);
        assert!(v["truncated"].is_string());
    }

    #[test]
    fn runaway_queries_are_stopped() {
        let (_d, path) = book();
        let conn = open_reader(&path).unwrap();
        let started = std::time::Instant::now();
        let err = run_select(
            &conn,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n",
        )
        .unwrap_err();
        assert!(err.contains("stopped"), "{err}");
        assert!(started.elapsed() < QUERY_TIMEOUT + Duration::from_secs(5));
    }

    #[test]
    fn tools_read_the_book() {
        let (_d, path) = book();
        let accounts = run_tool(&path, "list_accounts", &json!({})).unwrap();
        assert_eq!(accounts[0]["balance"], 100000 - 30000);
        let summary = run_tool(&path, "book_summary", &json!({ "month": "2026-10" })).unwrap();
        assert_eq!(summary["expense"], 30000);
        assert!(run_tool(&path, "query_book", &json!("not an object")).is_err());
        assert!(run_tool(&path, "query_book", &json!({})).is_err());
    }

    #[test]
    fn streamed_messages_are_put_back_together() {
        let mut m = SseMessage::default();
        let events = [
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Let me look."}}"#,
            r#"data: {"type":"content_block_stop","index":1}"#,
            r#"data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu","name":"query_book","input":{}}}"#,
            r#"data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"sql\": \"SEL"}}"#,
            r#"data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"ECT 1\"}"}}"#,
            r#"data: {"type":"content_block_stop","index":2}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
        ];
        for e in events {
            m.feed(&format!("event: x\n{e}")).unwrap();
        }
        let r = m.finish();
        assert_eq!(r.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(r.content[0], json!({"type":"thinking","thinking":"hm","signature":"sig"}));
        assert_eq!(r.content[1]["text"], "Let me look.");
        assert_eq!(r.content[2]["input"], json!({"sql":"SELECT 1"}));
    }

    #[test]
    fn a_fallback_drops_what_came_before_it() {
        let content = vec![
            json!({"type":"thinking","thinking":"","signature":"a"}),
            json!({"type":"text","text":"partial"}),
            json!({"type":"tool_use","id":"x","name":"query_book","input":{}}),
            json!({"type":"fallback","from":{"model":"m1"},"to":{"model":"m2"}}),
            json!({"type":"thinking","thinking":"","signature":"b"}),
            json!({"type":"text","text":"rest"}),
        ];
        let kept = echoable(content);
        let kinds: Vec<&str> = kept.iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["text", "fallback", "thinking", "text"]);
    }

    #[test]
    fn rupees_are_grouped_the_indian_way() {
        assert_eq!(inr(0), "₹0");
        assert_eq!(inr(99_900), "₹999");
        assert_eq!(inr(1_234_567_850), "₹1,23,45,678.50");
        assert_eq!(inr(-4_500_000), "−₹45,000");
    }

    #[test]
    fn changes_are_described_and_then_made() {
        let (_d, path) = book();
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO categories (id, kind, name, icon, color) VALUES
               ('food', 'expense', 'Food', 'utensils', '#F2724F'),
               ('cafe', 'expense', 'Cafes', 'coffee', '#F2724F');
             UPDATE categories SET parent_id = 'food' WHERE id = 'cafe';",
        )
        .unwrap();

        let add = json!({ "kind": "expense", "amount": 45000, "account_id": "a",
                          "category_id": "cafe", "merchant": "Blue Tokai", "occurred_at": "2026-11-20" });
        let (title, lines) = describe_change(&conn, "add_transaction", &add).unwrap();
        assert_eq!(title, "Add ₹450 expense");
        assert!(lines.contains(&"Food › Cafes".to_string()), "{lines:?}");
        let done = apply_change(&conn, "add_transaction", &add).unwrap();
        let id = done["id"].as_str().unwrap().to_string();
        assert_eq!(db::get_transaction(&conn, &id).unwrap().amount, 45000);

        // A group with sub-categories is refused by the app's own rule.
        let group = json!({ "ids": ["t1"], "category_id": "food" });
        assert!(apply_change(&conn, "update_transactions", &group).is_err());

        let bulk = json!({ "ids": ["t1", "t2"], "category_id": "cafe" });
        let (title, lines) = describe_change(&conn, "update_transactions", &bulk).unwrap();
        assert_eq!(title, "File under Food › Cafes · 2 transactions");
        assert_eq!(lines.len(), 2);
        let done = apply_change(&conn, "update_transactions", &bulk).unwrap();
        assert_eq!(done["changed"], 2);

        let edit = json!({ "id": "t1", "amount": 26000, "note": "with tip" });
        apply_change(&conn, "edit_transaction", &edit).unwrap();
        let t1 = db::get_transaction(&conn, "t1").unwrap();
        assert_eq!((t1.amount, t1.note.as_deref(), t1.category_id.as_deref()), (26000, Some("with tip"), Some("cafe")));

        let cat = apply_change(&conn, "add_category", &json!({ "name": "Bakeries", "kind": "expense", "parent_id": "food" })).unwrap();
        assert!(cat["id"].is_string());

        let gone = apply_change(&conn, "delete_transactions", &json!({ "ids": ["t2"] })).unwrap();
        assert_eq!(gone["deleted"], 1);
        assert!(apply_change(&conn, "add_transaction", &json!({ "kind": "expense" })).is_err());
        assert!(apply_change(&conn, "add_transaction", &json!({ "kind": "expense", "amount": -5,
            "account_id": "a", "merchant": "x", "occurred_at": "2026-11-20" })).is_err());
    }

    #[test]
    fn only_change_tools_count_as_writes() {
        let names: Vec<String> = tools().as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap().to_string()).collect();
        let writes: Vec<&String> = names.iter().filter(|n| is_write(n)).collect();
        assert_eq!(writes.len(), 6);
        assert!(!is_write("query_book") && !is_write("list_accounts") && !is_write("book_summary"));
    }

    #[test]
    fn comments_are_skipped_to_find_the_verb() {
        assert_eq!(first_keyword("  -- a\n /* b */ select 1"), "SELECT");
        assert_eq!(first_keyword("with x as (select 1) select * from x"), "WITH");
        assert_eq!(first_keyword("pragma table_info(x)"), "PRAGMA");
        assert!(has_second_statement("SELECT 1; SELECT 2"));
        assert!(!has_second_statement("SELECT ';' AS semi -- trailing; comment"));
        assert!(!has_second_statement("SELECT 1 /* a; b */"));
    }
}
