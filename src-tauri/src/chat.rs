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

/// Lets thinking bound to an older system prompt be dropped, not refused.
const BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";
use crate::db::{self, Db};
use crate::capture;
use crate::chat_actions;
use crate::chat_files;
use crate::cashback;
use crate::models::{
    CategoryInput, ImportCommitRow, Paise, StatementRow, Transaction, TransactionInput, TransactionPatch,
};
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
             WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'chats'
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
        },
        {
            "name": "read_statement",
            "description": "Read a bank or card statement the user attached to this chat (PDF, CSV, \
                spreadsheet or picture) against one of their accounts. Answers with every transaction on \
                it dated in the range, each numbered n, with a suggested filing and whether the book \
                already has it, plus a statement_id to import it with. Reading a long statement takes a \
                minute or two. Nothing is written.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The file's path exactly as attached." },
                    "account_id": { "type": "string", "description": "The account the statement belongs to." },
                    "from": { "type": "string", "description": "YYYY-MM-DD. Leave out to take the whole statement." },
                    "to": { "type": "string", "description": "YYYY-MM-DD. Leave out to take the whole statement." }
                },
                "required": ["path", "account_id"],
                "additionalProperties": false
            }
        }
    ]) else {
        unreachable!()
    };
    let mut list = list;
    list.push(chat_files::read_tool());
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
            | "import_statement"
            | "describe_transactions"
    ) || chat_actions::is_action(name)
}

fn write_tools() -> Vec<Value> {
    let note = " The user sees the change and approves or declines it before anything is written; \
                you get back what was done, or that they declined.";
    let mut tools = vec![
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
                    "splits": { "type": "array", "description": "Split the bill across categories: parts that add up to the amount exactly. Given on an edit, replaces the split; [] removes it.", "items": { "type": "object", "properties": { "id": { "type": "string" }, "amount": { "type": "integer" }, "category_id": { "type": "string" }, "note": { "type": "string" } }, "required": ["amount", "category_id"] } },
                    "shares": { "type": "array", "description": "Who else was in on it, each share a debt of its own (table debts, transaction_id = this transaction). A share for the whole amount makes the whole transaction a debt in that person's name. direction lent = they owe you; borrowed = you owe them. Given on an edit, replaces the shares: keep existing ones by passing their debt id as id; [] removes them all.", "items": { "type": "object", "properties": { "id": { "type": "string" }, "direction": { "type": "string", "enum": ["lent", "borrowed"] }, "counterparty": { "type": "string" }, "amount": { "type": "integer" }, "due_on": { "type": "string" }, "note": { "type": "string" } }, "required": ["direction", "counterparty", "amount"] } },
                    "refund_of": { "type": "string", "description": "The id of the transaction this one gives back (a refund). Opposite kind to it." },
                    "cashback": { "type": "integer", "description": "Cashback this card purchase earned, paise, when it isn't the card's usual rate." },
                    "label_ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["kind", "amount", "account_id", "merchant", "occurred_at"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "edit_transaction",
            "description": format!("Change one transaction. Only the fields given change; splits, shares, labels, \
                refund link and cashback are kept unless given. To make a transaction a debt in someone's name, \
                or split a bill with people, give it `shares`.{note}"),
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
                    "occurred_at": { "type": "string" },
                    "splits": { "type": "array", "description": "Split the bill across categories: parts that add up to the amount exactly. Given on an edit, replaces the split; [] removes it.", "items": { "type": "object", "properties": { "id": { "type": "string" }, "amount": { "type": "integer" }, "category_id": { "type": "string" }, "note": { "type": "string" } }, "required": ["amount", "category_id"] } },
                    "shares": { "type": "array", "description": "Who else was in on it, each share a debt of its own (table debts, transaction_id = this transaction). A share for the whole amount makes the whole transaction a debt in that person's name. direction lent = they owe you; borrowed = you owe them. Given on an edit, replaces the shares: keep existing ones by passing their debt id as id; [] removes them all.", "items": { "type": "object", "properties": { "id": { "type": "string" }, "direction": { "type": "string", "enum": ["lent", "borrowed"] }, "counterparty": { "type": "string" }, "amount": { "type": "integer" }, "due_on": { "type": "string" }, "note": { "type": "string" } }, "required": ["direction", "counterparty", "amount"] } },
                    "refund_of": { "type": "string", "description": "The id of the transaction this one gives back (a refund). Opposite kind to it." },
                    "cashback": { "type": "integer", "description": "Cashback this card purchase earned, paise, when it isn't the card's usual rate." },
                    "label_ids": { "type": "array", "items": { "type": "string" }, "description": "Replaces the labels it wears." }
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
        json!({
            "name": "import_statement",
            "description": format!("Import the rows of a statement read with read_statement into the book, \
                the way the Import with Claude sheet does: rows already in the book are always left out, \
                rows Claude wasn't sure of and you didn't change arrive labelled Triage, and the rest teach \
                the importer how to file that counterparty next time. Skip rows or refile them by their \
                row number n.{note}"),
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "statement_id": { "type": "string" },
                    "skip": { "type": "array", "items": { "type": "integer" }, "description": "Row numbers to leave out." },
                    "changes": {
                        "type": "array",
                        "description": "Filings to use instead of the suggested ones.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "n": { "type": "integer" },
                                "kind": { "type": "string", "enum": ["expense", "income", "transfer"] },
                                "category_id": { "type": "string" },
                                "transfer_account_id": { "type": "string" },
                                "merchant": { "type": "string" }
                            },
                            "required": ["n"],
                            "additionalProperties": false
                        }
                    },
                    "already_in_balance": {
                        "type": "boolean",
                        "description": "True when the account's balance in the app already includes these rows (filling in history); they are then recorded without moving any balance. Ask the user if unsure; default false."
                    }
                },
                "required": ["statement_id"],
                "additionalProperties": false
            }
        }),
    ];
    tools.push(chat_files::write_tool(note));
    tools.extend(chat_actions::tools(note));
    tools
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

pub(crate) fn name_of(conn: &Connection, table: &str, id: &str) -> String {
    conn.query_row(&format!("SELECT name FROM {table} WHERE id = ?1"), [id], |r| r.get::<_, String>(0))
        .unwrap_or_else(|_| format!("unknown ({id})"))
}

pub(crate) fn category_label(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' › ' || c.name END
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| format!("unknown category ({id})"))
}

/// One posting in a line: the day, who with, how much.
pub(crate) fn posting_line(conn: &Connection, id: &str) -> String {
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
    let input = &chat_actions::normalize(input);
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
        "import_statement" => describe_import(conn, input),
        "describe_transactions" => {
            let (rows, _) = chat_files::card_rows(conn, input)?;
            let lines = rows
                .iter()
                .take(CARD_ROWS)
                .map(|r| match &r.note {
                    Some(n) => format!("{} · {} · {} · {n}", r.date, r.merchant, inr(r.amount)),
                    None => format!("{} · {} · {}", r.date, r.merchant, inr(r.amount)),
                })
                .collect();
            Ok((chat_files::title(input)?, lines))
        }
        other if chat_actions::is_action(other) => {
            let (title, card) = chat_actions::describe(conn, other, input)?;
            let mut lines: Vec<String> = card
                .fields
                .iter()
                .map(|f| match &f.from {
                    Some(from) => format!("{}: {from} → {}", f.name, f.to),
                    None => format!("{}: {}", f.name, f.to),
                })
                .collect();
            lines.extend(card.rows.iter().map(|r| format!("{} · {} · {}", r.date, r.merchant, inr(r.amount))));
            Ok((title, lines))
        }
        other => Err(format!("There is no change called {other}.")),
    }
}

/// A change laid out for its confirm card: what kind of change it is, the
/// fields it sets (with what they were, where there is one thing to say it
/// of), and the transactions it touches, as rows a table can line up.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// add | edit | change | delete | category | label | import
    pub action: &'static str,
    pub fields: Vec<CardField>,
    pub rows: Vec<CardRow>,
    /// Rows touched beyond the ones listed.
    pub more: usize,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardField {
    pub name: String,
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub date: String,
    pub merchant: String,
    /// Paise, always positive; `kind` says which way it went.
    pub amount: Paise,
    pub kind: String,
    pub account: String,
    pub filed: String,
    /// The description it had, when the change gives it a new one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub was: Option<String>,
    /// The note the change gives it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

const CARD_ROWS: usize = 40;

/// The parts of a transaction beyond its own fields: split, shares, refund,
/// cashback and labels, as the card lists them.
fn transaction_extras(conn: &Connection, input: &Value) -> Vec<CardField> {
    let mut out = vec![];
    if let Some(parts) = input["splits"].as_array() {
        if parts.is_empty() {
            out.push(field("Split", None, "Taken off"));
        }
        for p in parts {
            let filed = p["category_id"].as_str().map(|c| category_label(conn, c)).unwrap_or_else(|| "No category".into());
            out.push(field("Split", None, format!("{} · {filed}", inr(p["amount"].as_i64().unwrap_or(0)))));
        }
    }
    if let Some(shares) = input["shares"].as_array() {
        if shares.is_empty() {
            out.push(field("Shared with", None, "Nobody: its debts go"));
        }
        for p in shares {
            let who = p["counterparty"].as_str().unwrap_or("someone");
            let amount = inr(p["amount"].as_i64().unwrap_or(0));
            let says = if p["direction"].as_str() == Some("borrowed") {
                format!("You owe {who} {amount}")
            } else {
                format!("{who} owes you {amount}")
            };
            out.push(field("Debt", None, says));
        }
    }
    if let Some(r) = input["refund_of"].as_str().filter(|r| !r.is_empty()) {
        out.push(field("Refund of", None, posting_line(conn, r)));
    }
    if let Some(c) = input["cashback"].as_i64() {
        out.push(field("Cashback", None, inr(c)));
    }
    if let Some(labels) = input["label_ids"].as_array() {
        let names: Vec<String> = labels.iter().filter_map(Value::as_str).map(|l| name_of(conn, "labels", l)).collect();
        out.push(field("Labels", None, if names.is_empty() { "None".into() } else { names.join(", ") }));
    }
    out
}

fn field(name: &str, from: Option<String>, to: impl Into<String>) -> CardField {
    CardField { name: name.into(), from, to: to.into() }
}

pub(crate) fn card_row(conn: &Connection, id: &str) -> Option<CardRow> {
    conn.query_row(
        "SELECT substr(t.occurred_at, 1, 10), t.merchant, t.amount, t.kind, a.name, ta.name, t.category_id
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN accounts ta ON ta.id = t.to_account_id
          WHERE t.id = ?1",
        [id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        },
    )
    .ok()
    .map(|(date, merchant, amount, kind, account, to, category)| CardRow {
        date,
        merchant,
        amount,
        account: match (&kind[..], to) {
            ("transfer", Some(to)) => format!("{account} → {to}"),
            _ => account,
        },
        filed: if kind == "transfer" {
            "Transfer".into()
        } else {
            category.map(|c| category_label(conn, &c)).unwrap_or_else(|| "No category".into())
        },
        kind,
..Default::default()
})
}

pub(crate) fn card_rows(conn: &Connection, ids: &[String]) -> (Vec<CardRow>, usize) {
    let rows: Vec<CardRow> = ids.iter().take(CARD_ROWS).filter_map(|id| card_row(conn, id)).collect();
    (rows, ids.len().saturating_sub(CARD_ROWS))
}

fn change_card(conn: &Connection, name: &str, input: &Value) -> Result<Card> {
    let input = &chat_actions::normalize(input);
    let mut card = Card::default();
    match name {
        "add_transaction" => {
            card.action = "add";
            let kind = want_str(input, "kind")?;
            let account = want_str(input, "account_id")?;
            card.rows.push(CardRow {
                date: opt_str(input, "occurred_at").map(|d| d.chars().take(10).collect()).unwrap_or_default(),
                merchant: opt_str(input, "merchant").unwrap_or_default(),
                amount: want_amount(input)?.ok_or("`amount` is required.")?,
                account: if kind == "transfer" {
                    format!(
                        "{} → {}",
                        name_of(conn, "accounts", &account),
                        opt_str(input, "to_account_id").map(|t| name_of(conn, "accounts", &t)).unwrap_or_else(|| "?".into())
                    )
                } else {
                    name_of(conn, "accounts", &account)
                },
                filed: if kind == "transfer" {
                    "Transfer".into()
                } else {
                    opt_str(input, "category_id").map(|c| category_label(conn, &c)).unwrap_or_else(|| "No category".into())
                },
                kind,
..Default::default()
});
            if let Some(n) = opt_str(input, "note") {
                card.fields.push(field("Note", None, n));
            }
            card.fields.extend(transaction_extras(conn, input));
        }
        "edit_transaction" => {
            card.action = "edit";
            let id = want_str(input, "id")?;
            let was = db::get_transaction(conn, &id).ok();
            let w = |f: &dyn Fn(&Transaction) -> String| was.as_ref().map(f);
            if let Some(k) = opt_str(input, "kind") {
                card.fields.push(field("Kind", w(&|t| t.kind.clone()), k));
            }
            if let Some(a) = want_amount(input)? {
                card.fields.push(field("Amount", w(&|t| inr(t.amount)), inr(a)));
            }
            if let Some(a) = opt_str(input, "account_id") {
                card.fields.push(field("Account", w(&|t| t.account_name.clone()), name_of(conn, "accounts", &a)));
            }
            if let Some(a) = opt_str(input, "to_account_id") {
                card.fields.push(field(
                    "To account",
                    w(&|t| t.to_account_name.clone().unwrap_or_else(|| "None".into())),
                    name_of(conn, "accounts", &a),
                ));
            }
            if let Some(c) = opt_str(input, "category_id") {
                card.fields.push(field(
                    "Category",
                    w(&|t| t.category_id.as_ref().map(|c| category_label(conn, c)).unwrap_or_else(|| "No category".into())),
                    category_label(conn, &c),
                ));
            }
            if let Some(m) = opt_str(input, "merchant") {
                card.fields.push(field("Description", w(&|t| t.merchant.clone()), m));
            }
            if let Some(n) = input["note"].as_str() {
                let to = if n.trim().is_empty() { "No note".to_string() } else { n.to_string() };
                card.fields.push(field("Note", w(&|t| t.note.clone().unwrap_or_else(|| "No note".into())), to));
            }
            if let Some(d) = opt_str(input, "occurred_at") {
                card.fields.push(field("Date", w(&|t| t.occurred_at.chars().take(10).collect()), d.chars().take(10).collect::<String>()));
            }
            card.fields.extend(transaction_extras(conn, input));
            card.rows.extend(card_row(conn, &id));
        }
        "update_transactions" => {
            card.action = "change";
            let ids = want_ids(input)?;
            if input["clear_category"].as_bool() == Some(true) {
                card.fields.push(field("Category", None, "No category"));
            } else if let Some(c) = opt_str(input, "category_id") {
                card.fields.push(field("Category", None, category_label(conn, &c)));
            }
            if let Some(a) = opt_str(input, "account_id") {
                card.fields.push(field("Account", None, name_of(conn, "accounts", &a)));
            }
            if let Some(m) = opt_str(input, "merchant") {
                card.fields.push(field("Description", None, m));
            }
            if input["clear_note"].as_bool() == Some(true) {
                card.fields.push(field("Note", None, "No note"));
            } else if let Some(n) = opt_str(input, "note") {
                card.fields.push(field("Note", None, n));
            }
            (card.rows, card.more) = card_rows(conn, &ids);
        }
        "delete_transactions" => {
            card.action = "delete";
            (card.rows, card.more) = card_rows(conn, &want_ids(input)?);
        }
        "add_category" => {
            card.action = "category";
            card.fields.push(field("Name", None, want_str(input, "name")?));
            let kind = want_str(input, "kind")?;
            card.fields.push(field("For", None, if kind == "income" { "Income" } else { "Spending" }));
            card.fields.push(field(
                "Sits under",
                None,
                opt_str(input, "parent_id")
                    .map(|p| name_of(conn, "categories", &p))
                    .unwrap_or_else(|| "Nothing: a new group of its own".into()),
            ));
        }
        "label_transactions" => {
            card.action = "label";
            let label = name_of(conn, "labels", &want_str(input, "label_id")?);
            let on = input["on"].as_bool().unwrap_or(true);
            card.fields.push(field("Label", None, if on { format!("Pin “{label}”") } else { format!("Take “{label}” off") }));
            (card.rows, card.more) = card_rows(conn, &want_ids(input)?);
        }
        "import_statement" => {
            card.action = "import";
            let id = want_str(input, "statement_id")?;
            let (_, lines) = describe_import(conn, input)?;
            with_statement(&id, |s| {
                card.fields.push(field("Into", None, s.account_name.clone()));
                card.fields.push(field("From", None, s.file.clone()));
                let rows = import_rows(s, input)?;
                card.more = rows.len().saturating_sub(CARD_ROWS);
                card.rows = rows
                    .iter()
                    .take(CARD_ROWS)
                    .map(|r| CardRow {
                        date: r.row.date.clone(),
                        merchant: if r.input.merchant.is_empty() { r.row.narration.clone() } else { r.input.merchant.clone() },
                        amount: r.row.amount,
                        kind: r.input.kind.clone(),
                        account: s.account_name.clone(),
                        filed: match (&r.input.category_id, r.input.kind.as_str()) {
                            (_, "transfer") => "Transfer".to_string(),
                            (Some(c), _) => category_label(conn, c),
                            (None, _) => "No category".into(),
                        },
..Default::default()
})
                    .collect();
                Ok(())
            })?;
            // The summary lines, without the sample rows the table now shows.
            card.notes = lines
                .into_iter()
                .filter(|l| {
                    let head: Vec<char> = l.chars().take(5).collect();
                    let dated = head.len() == 5 && head[4] == '-' && head[..4].iter().all(char::is_ascii_digit);
                    !dated && !l.starts_with("and ")
                })
                .collect();
        }
        "describe_transactions" => {
            card.action = "edit";
            let (rows, notes) = chat_files::card_rows(conn, input)?;
            card.rows = rows;
            card.notes = notes;
        }
        other if chat_actions::is_action(other) => return Ok(chat_actions::describe(conn, other, input)?.1),
        other => return Err(format!("There is no change called {other}.")),
    }
    Ok(card)
}

/// Makes one approved change on the app's own connection, and says what
/// happened in words the history can show.
fn apply_change(conn: &Connection, name: &str, input: &Value) -> Result<Value> {
    let input = &chat_actions::normalize(input);
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
                    splits: chat_actions::opt_parse(&input["splits"])?,
                    shares: chat_actions::opt_parse(&input["shares"])?,
                    label_ids: input["label_ids"].as_array().map(|a| {
                        a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                    }),
                    refund_of: opt_str(input, "refund_of"),
                    cashback: input["cashback"].as_i64(),
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
                    // Absent, these are kept as they are; given, they
                    // replace what the transaction had.
                    splits: chat_actions::opt_parse(&input["splits"])?,
                    shares: chat_actions::opt_parse(&input["shares"])?,
                    label_ids: chat_actions::opt_parse(&input["label_ids"])?,
                    refund_of: match &input["refund_of"] {
                        Value::Null => was.refund_of,
                        v => v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from),
                    },
                    cashback: match &input["cashback"] {
                        Value::Null => was.cashback_set,
                        v => v.as_i64(),
                    },
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
        "import_statement" => apply_import(conn, input, title)?,
        "describe_transactions" => {
            let mut done = chat_files::apply(conn, input)?;
            done["done"] = json!(title);
            done
        }
        other if chat_actions::is_action(other) => {
            let mut done = chat_actions::apply(conn, other, input)?;
            done["done"] = json!(title);
            done
        }
        other => return Err(format!("There is no change called {other}.")),
    };
    // Whatever landed on a card changes what its cycle earns back.
    if let Err(e) = cashback::settle(conn) {
        eprintln!("cashback could not be settled: {e}");
    }
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
    /// The same change laid out for the card; absent if it couldn't be read.
    pub card: Option<Card>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub messages: Vec<Value>,
    /// Changes Claude has asked to make. When there are any, the
    /// conversation ends on Claude's turn and waits for the user's answer.
    pub pending: Vec<PendingChange>,
}

// ------------------------------------------------------------- statements
//
// A statement dropped on the Ask screen arrives as a path in the user's
// message, under ATTACHED. Claude reads it with `read_statement`, which runs
// the same reader the import sheet uses and holds what it found against the
// book's duplicate check; `import_statement` then posts the rows the way the
// sheet's commit does, once the user applies it. What was read is kept in
// memory by id until then, so the rows Claude talks about are the rows that
// go in.

/// How the screen marks files attached to a question: this line, then one
/// `- /path` line per file.
pub const ATTACHED: &str = "Attached statement files:";

/// Every file attached anywhere in the conversation. Only these can be read.
fn attached_paths(messages: &[Value]) -> HashSet<String> {
    let mut out = HashSet::new();
    for m in messages.iter().filter(|m| m["role"] == "user") {
        let Some(blocks) = m["content"].as_array() else { continue };
        for b in blocks {
            let Some(text) = b["text"].as_str() else { continue };
            let Some(rest) = text.strip_prefix(ATTACHED) else { continue };
            for line in rest.lines() {
                if let Some(path) = line.trim().strip_prefix("- ") {
                    out.insert(path.trim().to_string());
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone)]
struct Found {
    row: StatementRow,
    /// Already in the book, by the importer's own matching.
    in_book: Option<String>,
    kind: String,
    category_id: Option<String>,
    transfer_account_id: Option<String>,
    merchant: String,
    note: String,
    confidence: String,
    /// The filing came from a rule someone confirmed by hand.
    remembered: bool,
}

#[derive(Debug, Clone)]
struct ReadStatement {
    account_id: String,
    account_name: String,
    file: String,
    rows: Vec<Found>,
    imported: bool,
}

static STATEMENTS: Mutex<Option<HashMap<String, ReadStatement>>> = Mutex::new(None);

fn with_statement<T>(id: &str, f: impl FnOnce(&mut ReadStatement) -> Result<T>) -> Result<T> {
    let mut all = STATEMENTS.lock().map_err(|e| e.to_string())?;
    let s = all
        .get_or_insert_with(HashMap::new)
        .get_mut(id)
        .ok_or("That statement isn't held any more (the app was restarted). Read it again with read_statement.")?;
    f(s)
}

/// Reads one attached statement against an account, and answers with every
/// row: what Claude made of it, and whether the book already has it.
async fn read_statement(
    app: &AppHandle,
    run: &str,
    book: &Path,
    input: &Value,
    allowed: &HashSet<String>,
) -> Result<Value> {
    let path = want_str(input, "path")?;
    if !allowed.contains(&path) {
        return Err("Only statements attached to this chat can be read. Use the exact path from the attachment.".into());
    }
    let account_id = want_str(input, "account_id")?;
    let from = opt_str(input, "from").unwrap_or_else(|| "2000-01-01".into());
    let to = opt_str(input, "to").unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

    let (account, categories, accounts) = {
        let book = book.to_path_buf();
        let account_id = account_id.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<_> {
            let conn = open_reader(&book)?;
            let accounts = db::list_accounts(&conn)?;
            let categories = db::list_categories(&conn)?;
            let account = accounts
                .iter()
                .find(|a| a.id == account_id)
                .cloned()
                .ok_or("There is no account with that id.")?;
            let accounts: Vec<_> = accounts.into_iter().filter(|a| !a.archived && !a.system).collect();
            Ok((account, categories, accounts))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let file = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let account_name = account.name.clone();

    let read = ai::read_statements(
        app.clone(),
        run.to_string(),
        vec![path.clone()],
        account,
        from,
        to,
        categories,
        accounts,
    )
    .await?;

    // The same line listed twice is one line.
    let mut seen = HashSet::new();
    let read: Vec<ai::AiRow> = read
        .into_iter()
        .filter(|r| {
            seen.insert(format!("{}|{}|{}|{}", r.row.date, r.row.amount, r.row.direction, r.row.narration))
        })
        .collect();

    let preview = {
        let book = book.to_path_buf();
        let account_id = account_id.clone();
        let rows: Vec<StatementRow> = read.iter().map(|r| r.row.clone()).collect();
        tauri::async_runtime::spawn_blocking(move || {
            let conn = open_reader(&book)?;
            db::preview_import(&conn, &account_id, rows)
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let mut rows: Vec<Found> = read
        .into_iter()
        .zip(preview)
        .map(|(ai, p)| {
            let remembered = p.from_rule && p.rule_confirmed;
            Found {
                in_book: (p.status == "matched")
                    .then(|| p.matched_summary.clone().unwrap_or_else(|| "a posting already in the book".into())),
                kind: if remembered { p.kind.clone() } else { ai.kind.clone() },
                category_id: if remembered { p.category_id.clone() } else { ai.category_id.clone() },
                transfer_account_id: if remembered {
                    p.transfer_account_id.clone()
                } else {
                    ai.transfer_account_id.clone()
                },
                merchant: if remembered { p.merchant.clone() } else { ai.description.clone() },
                note: ai.note.clone(),
                confidence: ai.confidence.clone(),
                remembered,
                row: ai.row,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.row.date.cmp(&b.row.date));

    let id = format!("st_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let listed: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let mut v = json!({
                "n": i + 1,
                "date": f.row.date,
                "narration": f.row.narration,
                "amount": f.row.amount,
                "direction": f.row.direction,
                "kind": f.kind,
                "category_id": f.category_id,
                "merchant": f.merchant,
                "confidence": f.confidence,
            });
            if let Some(t) = &f.transfer_account_id {
                v["transfer_account_id"] = json!(t);
            }
            if let Some(m) = &f.in_book {
                v["already_in_book"] = json!(m);
            }
            if f.remembered {
                v["filed_by_rule"] = json!(true);
            }
            v
        })
        .collect();
    let new = rows.iter().filter(|r| r.in_book.is_none()).count();
    let answer = json!({
        "statement_id": id,
        "account": account_name,
        "file": file,
        "rows_found": rows.len(),
        "already_in_book": rows.len() - new,
        "new": new,
        "rows": listed,
    });
    STATEMENTS
        .lock()
        .map_err(|e| e.to_string())?
        .get_or_insert_with(HashMap::new)
        .insert(
            id,
            ReadStatement { account_id, account_name, file, rows, imported: false },
        );
    Ok(answer)
}

/// The postings an import would write, after the rows Claude skipped and
/// refiled. Mirrors the import sheet: a guess nobody changed and Claude
/// wasn't sure of arrives in Triage; everything else teaches its rule.
fn import_rows(s: &ReadStatement, input: &Value) -> Result<Vec<ImportCommitRow>> {
    let skip: HashSet<u64> = input["skip"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default();
    let mut changes: HashMap<u64, &Value> = HashMap::new();
    for c in input["changes"].as_array().into_iter().flatten() {
        let n = c["n"].as_u64().ok_or("Every change needs the row number `n`.")?;
        if n == 0 || n as usize > s.rows.len() {
            return Err(format!("There is no row {n} on that statement."));
        }
        changes.insert(n, c);
    }
    let affects_balance = !input["already_in_balance"].as_bool().unwrap_or(false);
    let mut out = Vec::new();
    for (i, f) in s.rows.iter().enumerate() {
        let n = (i + 1) as u64;
        if f.in_book.is_some() || skip.contains(&n) {
            continue;
        }
        let change = changes.get(&n);
        let edited = change.is_some();
        let pick = |key: &str, was: &Option<String>| -> Option<String> {
            match change.map(|c| &c[key]) {
                Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                Some(Value::Null) if change.map(|c| c.get(key).is_some()).unwrap_or(false) => None,
                _ => was.clone(),
            }
        };
        let kind = pick("kind", &Some(f.kind.clone())).unwrap_or_else(|| f.kind.clone());
        let category_id = pick("category_id", &f.category_id);
        let transfer = pick("transfer_account_id", &f.transfer_account_id);
        let merchant = pick("merchant", &Some(f.merchant.clone())).unwrap_or_default();
        let debit = f.row.direction == "debit";
        let (kind, account_id, to_account_id, category_id) = match (kind.as_str(), transfer) {
            ("transfer", Some(other)) => {
                if debit {
                    ("transfer".to_string(), s.account_id.clone(), Some(other), None)
                } else {
                    ("transfer".to_string(), other, Some(s.account_id.clone()), None)
                }
            }
            _ => (
                if debit { "expense" } else { "income" }.to_string(),
                s.account_id.clone(),
                None,
                category_id,
            ),
        };
        let unsure = !edited
            && !f.remembered
            && (f.confidence == "low" || (kind != "transfer" && category_id.is_none()));
        out.push(ImportCommitRow {
            row: f.row.clone(),
            input: TransactionInput {
                id: None,
                kind,
                amount: f.row.amount,
                account_id,
                to_account_id,
                category_id,
                merchant,
                note: (!f.note.trim().is_empty()).then(|| f.note.trim().to_string()),
                occurred_at: format!("{}T12:00", f.row.date),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
            triage: unsure,
            learn: !unsure,
            affects_balance,
        });
    }
    Ok(out)
}

fn describe_import(conn: &Connection, input: &Value) -> Result<(String, Vec<String>)> {
    let id = want_str(input, "statement_id")?;
    with_statement(&id, |s| {
        if s.imported {
            return Err("That statement has already been imported.".into());
        }
        let rows = import_rows(s, input)?;
        let in_book = s.rows.iter().filter(|r| r.in_book.is_some()).count();
        let skipped = s.rows.len() - in_book - rows.len();
        let spent: Paise = rows.iter().filter(|r| r.row.direction == "debit").map(|r| r.row.amount).sum();
        let came: Paise = rows.iter().filter(|r| r.row.direction != "debit").map(|r| r.row.amount).sum();
        let triage = rows.iter().filter(|r| r.triage).count();
        let mut lines = vec![format!("{} out · {} in", inr(spent), inr(came))];
        if in_book > 0 {
            lines.push(format!("{} already in the book, left out", plural(in_book, "row")));
        }
        if skipped > 0 {
            lines.push(format!("{} skipped", plural(skipped, "row")));
        }
        if triage > 0 {
            lines.push(format!("{} Claude wasn't sure of will be labelled Triage", plural(triage, "row")));
        }
        if !rows.first().map(|r| r.affects_balance).unwrap_or(true) {
            lines.push("Recorded as history, without moving any balance".into());
        }
        for r in rows.iter().take(5) {
            let filed = match (&r.input.category_id, r.input.kind.as_str()) {
                (_, "transfer") => "transfer".to_string(),
                (Some(c), _) => category_label(conn, c),
                (None, _) => "no category".into(),
            };
            lines.push(format!(
                "{} · {} · {}{} · {filed}",
                r.row.date,
                if r.input.merchant.is_empty() { &r.row.narration } else { &r.input.merchant },
                if r.row.direction == "debit" { "−" } else { "+" },
                inr(r.row.amount),
            ));
        }
        if rows.len() > 5 {
            lines.push(format!("and {} more", rows.len() - 5));
        }
        Ok((
            format!("Import {} into {} from {}", plural(rows.len(), "transaction"), s.account_name, s.file),
            lines,
        ))
    })
}

fn apply_import(conn: &Connection, input: &Value, title: String) -> Result<Value> {
    let id = want_str(input, "statement_id")?;
    with_statement(&id, |s| {
        if s.imported {
            return Err("That statement has already been imported.".into());
        }
        let rows = import_rows(s, input)?;
        if rows.is_empty() {
            return Err("There is nothing left to import from that statement.".into());
        }
        let done = db::commit_import(conn, &s.account_id, rows)?;
        s.imported = true;
        Ok(json!({
            "done": title,
            "inserted": done.inserted,
            "triaged": done.triaged,
            "balance_neutral": done.balance_neutral,
            "opening_adjustment": done.opening_adjustment,
        }))
    })
}

// ------------------------------------------------------------- saved chats
//
// Conversations are kept in the book, so they travel with it and go when
// it is wiped. The transcript is the API's own JSON, kept whole so a chat
// opened later carries on exactly where it stopped.

pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chats (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            messages   TEXT NOT NULL,
            pending    TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChat {
    pub id: String,
    pub title: String,
    pub messages: Vec<Value>,
    pub pending: Vec<Value>,
}

pub fn list_chats(conn: &Connection) -> Result<Vec<ChatSummary>> {
    ensure_table(conn)?;
    let mut stmt = conn
        .prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ChatSummary { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string());
    rows
}

pub fn load_chat(conn: &Connection, id: &str) -> Result<SavedChat> {
    ensure_table(conn)?;
    let (title, messages, pending): (String, String, String) = conn
        .query_row("SELECT title, messages, pending FROM chats WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|_| "That chat no longer exists.".to_string())?;
    Ok(SavedChat {
        id: id.to_string(),
        title,
        messages: serde_json::from_str(&messages).map_err(|e| e.to_string())?,
        pending: serde_json::from_str(&pending).unwrap_or_default(),
    })
}

pub fn save_chat(conn: &Connection, id: &str, title: &str, messages: &[Value], pending: &[Value]) -> Result<()> {
    ensure_table(conn)?;
    let now = db::now();
    let title: String = title.trim().chars().take(120).collect();
    conn.execute(
        "INSERT INTO chats (id, title, messages, pending, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, messages = excluded.messages,
                                       pending = excluded.pending, updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            if title.is_empty() { "Untitled chat".to_string() } else { title },
            serde_json::to_string(messages).map_err(|e| e.to_string())?,
            serde_json::to_string(pending).map_err(|e| e.to_string())?,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_chat(conn: &Connection, id: &str) -> Result<()> {
    ensure_table(conn)?;
    conn.execute("DELETE FROM chats WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Gives a saved chat a name of the user's own. Nothing else about it moves,
/// its place in the list included.
pub fn rename_chat(conn: &Connection, id: &str, title: &str) -> Result<()> {
    ensure_table(conn)?;
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("A chat needs a name.".into());
    }
    let title: String = title.chars().take(120).collect();
    let n = conn
        .execute("UPDATE chats SET title = ?2 WHERE id = ?1", rusqlite::params![id, title])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That chat isn't saved any more.".into());
    }
    Ok(())
}

pub fn clear_chats(conn: &Connection) -> Result<()> {
    ensure_table(conn)?;
    conn.execute("DELETE FROM chats", []).map_err(|e| e.to_string())?;
    Ok(())
}

// ----------------------------------------------------------------- prompt

fn system_prompt(schema: &str) -> String {
    format!(
        r#"You are the assistant inside flow, a personal finance app that keeps its book in a local SQLite database on the user's Mac. The user asks about their own money — spending, income, categories, accounts, cards, debts, investments, plans — and you answer from the book using your tools.

You can also change the book, but only with the change tools (add_transaction, edit_transaction, update_transactions, delete_transactions, add_category, label_transactions, import_statement, and debts, labels, folders, categories, accounts, plans, templates, investments, captures and mark_reviewed for everything else the app does) and only when the user asks for a change. Between them they can do anything the app's own screens can: turn a transaction into a debt or share a bill (edit_transaction with `shares`), split a bill across categories, mark a refund, record repayments, make and fill labels and folders, rename or move categories, set card terms, set up and pay planned payments, and so on. A tool that saves a record by `id` replaces it whole, so read the row first and pass every field. Only exporting, importing or resetting the whole book is left to the app. Each change is shown to the user, who applies or declines it; nothing is written until they do. Before proposing one, look up the exact ids you need and check you have the right transactions — for a bulk change, query them first and say how many there are. Prefer one bulk change over many single ones. The bulk edit won't file transactions under a group that has sub-categories; pick one of its sub-categories. Never change anything the user didn't ask to change, and if what they want is ambiguous, ask first. Your SQL is always read-only; changes only ever go through those tools.

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

## Selected transactions

The user can pick transactions in the ledger and bring them here; they arrive in their message after a line reading "Selected transactions:", with the count, then one line per transaction starting with its id (with date, description, amount, account and category where the ledger had them). "These", "them" and "the selected ones" mean those rows. Look them up by id in the transactions table (`WHERE t.id IN (...)`) for anything the lines leave out, and pass those ids to the change tools when the user asks to change them. Later questions in the chat may come with a different selection; the latest one is what "these" means.

## Statements

The user can drop bank or card statements onto the chat; they arrive in their message after a line reading "Attached statement files:", one path per line. To import one: work out which account it belongs to (from the file name, the bank, or by asking — list_accounts has them), read it with read_statement (leave the dates out unless the user gave a range), then tell the user briefly what you found: how many rows, how many are already in the book, and any you're unsure how to file. Then propose import_statement, refiling any rows the user corrected or that you can file better with the categories in the book. If the user hasn't said whether the account's balance in the app already includes these transactions and it isn't obvious, ask before importing: it decides already_in_balance.

## Order histories and other files

The same "Attached statement files:" list can hold files that aren't statements: order histories and other exports (Swiggy or Zomato orders, Amazon orders, Uber rides; JSON, JSON Lines, CSV, text, HTML or spreadsheets). Read those with read_file, not read_statement; they add detail to transactions already in the book rather than new ones. For a JSON file, read its outline first, then just the fields you need (order id, time, total paid, merchant or restaurant, item names), a page at a time.

To use one: find the book's transactions it could describe (for Swiggy, merchants LIKE '%swiggy%' on the cards and UPI accounts it was paid from), and match each order to one transaction by the amount actually paid (to the paisa, after discounts, fees and tips) and the date (the charge can post a day or two after the order). Only match when one transaction fits; leave out orders that fit none or several, and don't reuse a transaction for two orders. Tell the user briefly how many matched, how many didn't and why, then propose describe_transactions with the matches: keep the description short (e.g. "Swiggy · Meghana Foods") and put what was bought in the note (e.g. "Chicken biryani, Raita"), keeping anything already in a note that isn't from the order. Ask first if the user hasn't said how they want descriptions and notes written and the book's existing ones suggest a different style. Large files go in batches of up to 300 per change.

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
    attached: &HashSet<String>,
) -> Result<Value> {
    let mut results = Vec::with_capacity(calls.len());
    let mut wrote = false;
    for (id, name, input) in calls {
        let write = is_write(&name);
        let outcome = if write && decisions.get(&id) != Some(&true) {
            Ok(json!({ "declined": DECLINED }))
        } else if name == "read_statement" {
            read_statement(app, run, book, &input, attached).await
        } else if name == "read_file" {
            let input = input.clone();
            let attached = attached.clone();
            tauri::async_runtime::spawn_blocking(move || chat_files::read_file(&input, &attached))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
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
                done.rows = v["row_count"]
                    .as_u64()
                    .or_else(|| v["rows_found"].as_u64())
                    .map(|n| n as usize)
                    .or_else(|| v.as_array().map(Vec::len));
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
            let answered = answer_calls(&app, &run, &book, waiting, &decisions, &attached_paths(&messages)).await?;
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
                // A saved chat's thinking is bound to the system prompt it was
                // written under, and that prompt moves: the schema grows, the
                // rules get revised. Thinking that no longer matches is
                // dropped rather than failing the whole question.
                "thinking": {
                    "type": "adaptive",
                    "block_binding": { "prefix_mismatch_behavior": "drop_block" },
                },
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
                            let card = change_card(&conn, &tool, &input).ok();
                            PendingChange { id, tool, title, lines, card }
                        })
                        .collect())
                })
                .await
                .map_err(|e| e.to_string())??;
                return Ok(pending);
            }

            let answered = answer_calls(&app, &run, &book, calls, &HashMap::new(), &attached_paths(&messages)).await?;
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
    // Both are betas. If one is turned away, ask again without it.
    let mut body = body.clone();
    let mut betas = vec![FALLBACK_BETA, BINDING_BETA];
    let mut resp;
    loop {
        resp = send(&body, &betas)
            .await
            .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
        if resp.status() != reqwest::StatusCode::BAD_REQUEST {
            break;
        }
        let err = ai::api_error(resp).await;
        let lower = err.to_lowercase();
        let obj = body.as_object_mut().ok_or("bad request body")?;
        if lower.contains("fallback") && obj.contains_key("fallbacks") {
            obj.remove("fallbacks");
            betas.retain(|b| *b != FALLBACK_BETA);
        } else if (lower.contains("block_binding") || lower.contains("thinking-binding"))
            && betas.contains(&BINDING_BETA)
        {
            if let Some(t) = obj.get_mut("thinking").and_then(Value::as_object_mut) {
                t.remove("block_binding");
            }
            betas.retain(|b| *b != BINDING_BETA);
        } else {
            return Err(err);
        }
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
        let card = change_card(&conn, "update_transactions", &bulk).unwrap();
        assert_eq!((card.action, card.rows.len(), card.more), ("change", 2, 0));
        assert_eq!(card.fields[0].to, "Food › Cafes");
        let done = apply_change(&conn, "update_transactions", &bulk).unwrap();
        assert_eq!(done["changed"], 2);

        let edit = json!({ "id": "t1", "amount": 26000, "note": "with tip" });
        let card = change_card(&conn, "edit_transaction", &edit).unwrap();
        assert_eq!(card.fields[0].name, "Amount");
        assert!(card.fields[0].from.is_some());
        assert_eq!(card.fields[0].to, "₹260");
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
    fn orders_describe_transactions_each_their_own() {
        let (_d, path) = book();
        let conn = db::open(&path).unwrap();
        let mut ids = vec![];
        for (amount, note) in [(41250, None), (18900, Some("office"))] {
            let mut add = json!({ "kind": "expense", "amount": amount, "account_id": "a",
                                  "merchant": "SWIGGY", "occurred_at": "2026-11-03" });
            if let Some(n) = note { add["note"] = json!(n); }
            ids.push(apply_change(&conn, "add_transaction", &add).unwrap()["id"].as_str().unwrap().to_string());
        }
        let change = json!({ "source": "Swiggy orders", "items": [
            { "id": ids[0], "merchant": "Swiggy · Meghana Foods", "note": "Biryani, Raita" },
            { "id": ids[1], "note": "office · Latte" },
        ] });
        let card = change_card(&conn, "describe_transactions", &change).unwrap();
        assert_eq!(card.rows.len(), 2);
        assert_eq!(card.rows[0].merchant, "Swiggy · Meghana Foods");
        assert_eq!(card.rows[0].was.as_deref(), Some("SWIGGY"));
        assert!(card.rows[1].was.is_none());
        assert_eq!(card.rows[1].note.as_deref(), Some("office · Latte"));
        let done = apply_change(&conn, "describe_transactions", &change).unwrap();
        assert_eq!(done["changed"], 2);
        assert_eq!(done["done"], "Describe 2 transactions from Swiggy orders");
        let a = db::get_transaction(&conn, &ids[0]).unwrap();
        assert_eq!((a.merchant.as_str(), a.note.as_deref()), ("Swiggy · Meghana Foods", Some("Biryani, Raita")));
        let b = db::get_transaction(&conn, &ids[1]).unwrap();
        assert_eq!((b.merchant.as_str(), b.note.as_deref()), ("SWIGGY", Some("office · Latte")));
    }

    #[test]
    fn the_rest_of_the_app_is_reachable() {
        let (_d, path) = book();
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO categories (id, kind, name, icon, color) VALUES ('food', 'expense', 'Food', 'utensils', '#F2724F');",
        )
        .unwrap();
        let add = json!({ "kind": "expense", "amount": 120000, "account_id": "a", "category_id": "food",
                          "merchant": "Dinner", "occurred_at": "2026-11-20" });
        let tx = apply_change(&conn, "add_transaction", &add).unwrap()["id"].as_str().unwrap().to_string();

        // The whole bill becomes Ravi's debt.
        let owe = json!({ "id": tx, "shares": [{ "direction": "lent", "counterparty": "Ravi", "amount": 120000 }] });
        let card = change_card(&conn, "edit_transaction", &owe).unwrap();
        assert!(card.fields.iter().any(|f| f.to == "Ravi owes you ₹1,200"), "{:?}", card.fields);
        apply_change(&conn, "edit_transaction", &owe).unwrap();
        let debt: String = conn
            .query_row("SELECT id FROM debts WHERE transaction_id = ?1 AND counterparty = 'Ravi'", [&tx], |r| r.get(0))
            .unwrap();

        // He pays some of it back; the amount written as text, as Claude
        // sometimes does, still reads as the number it is.
        let pay = json!({ "action": "payment", "debt_id": debt, "amount": "50000", "occurred_at": "2026-11-22" });
        let (title, _) = describe_change(&conn, "debts", &pay).unwrap();
        assert!(title.starts_with("Record ₹500 paid back on Ravi"), "{title}");
        apply_change(&conn, "debts", &pay).unwrap();

        // A label and a folder, made and used.
        let label = apply_change(&conn, "labels", &json!({ "action": "save", "name": "Trip", "color": "#118AE4" })).unwrap();
        let label = label["id"].as_str().unwrap().to_string();
        apply_change(&conn, "label_transactions", &json!({ "ids": [tx], "label_id": label })).unwrap();
        let folder = apply_change(&conn, "folders", &json!({ "action": "save", "name": "Goa", "color": "#118AE4", "icon": "plane" })).unwrap();
        let folder = folder["id"].as_str().unwrap().to_string();
        let put = apply_change(&conn, "folders", &json!({ "action": "add", "folder_id": folder, "ids": [tx] })).unwrap();
        assert_eq!(put["added"], 1);

        // A category renamed shows what it was.
        let rename = json!({ "action": "save", "id": "food", "kind": "expense", "name": "Eating out", "icon": "utensils", "color": "#F2724F" });
        let card = change_card(&conn, "categories", &rename).unwrap();
        assert_eq!(card.action, "edit");
        let name = card.fields.iter().find(|f| f.name == "Name").unwrap();
        assert_eq!((name.from.as_deref(), name.to.as_str()), (Some("Food"), "Eating out"));
        assert_eq!(card.fields.len(), 1, "{:?}", card.fields);
        apply_change(&conn, "categories", &rename).unwrap();
        assert_eq!(name_of(&conn, "categories", "food"), "Eating out");

        // Deleting anything reads as a delete.
        let card = change_card(&conn, "accounts", &json!({ "action": "delete", "id": "a" })).unwrap();
        assert_eq!(card.action, "delete");
        assert!(describe_change(&conn, "accounts", &json!({ "action": "launch" })).is_err());
        assert!(apply_change(&conn, "mark_reviewed", &json!({ "ids": [tx] })).is_ok());
    }

    #[test]
    fn only_change_tools_count_as_writes() {
        let names: Vec<String> = tools().as_array().unwrap().iter()
            .map(|t| t["name"].as_str().unwrap().to_string()).collect();
        let writes: Vec<&String> = names.iter().filter(|n| is_write(n)).collect();
        assert_eq!(writes.len(), 18);
        assert!(!is_write("query_book") && !is_write("list_accounts") && !is_write("book_summary") && !is_write("read_statement") && !is_write("read_file"));
    }

    #[test]
    fn only_attached_files_can_be_read() {
        let messages = vec![
            json!({ "role": "user", "content": [
                { "type": "text", "text": "import this" },
                { "type": "text", "text": format!("{ATTACHED}\n- /Users/me/Downloads/hdfc oct.pdf\n- /tmp/b.csv") },
            ]}),
            json!({ "role": "user", "content": "- /etc/passwd" }),
        ];
        let got = attached_paths(&messages);
        assert!(got.contains("/Users/me/Downloads/hdfc oct.pdf"));
        assert!(got.contains("/tmp/b.csv"));
        assert_eq!(got.len(), 2);
    }

    fn statement_row(date: &str, narration: &str, amount: Paise, direction: &str) -> StatementRow {
        StatementRow {
            date: date.into(),
            narration: narration.into(),
            ref_no: String::new(),
            amount,
            direction: direction.into(),
            balance: None,
        }
    }

    fn found(row: StatementRow, kind: &str, category: Option<&str>, confidence: &str) -> Found {
        Found {
            in_book: None,
            kind: kind.into(),
            category_id: category.map(String::from),
            transfer_account_id: None,
            merchant: row.narration.clone(),
            note: String::new(),
            confidence: confidence.into(),
            remembered: false,
            row,
        }
    }

    #[test]
    fn a_read_statement_is_imported_once_as_shown() {
        let (_d, path) = book();
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id, name, kind, opening_balance, color, icon, created_at)
             VALUES ('card', 'Card', 'credit', 0, '#000', 'x', '2026-01-01');
             INSERT INTO categories (id, kind, name, icon, color) VALUES
               ('food', 'expense', 'Food', 'utensils', '#F2724F'),
               ('pay', 'income', 'Salary', 'banknote', '#42C251');",
        )
        .unwrap();
        let mut already = found(statement_row("2026-10-02", "CAFE", 25000, "debit"), "expense", Some("food"), "high");
        already.in_book = Some("Cafe".into());
        let s = ReadStatement {
            account_id: "a".into(),
            account_name: "Bank".into(),
            file: "oct.pdf".into(),
            rows: vec![
                already,
                found(statement_row("2026-10-05", "SWIGGY", 41250, "debit"), "expense", Some("food"), "high"),
                found(statement_row("2026-10-06", "MYSTERY", 9900, "debit"), "expense", None, "low"),
                found(statement_row("2026-10-07", "CC PAYMENT", 20000, "debit"), "transfer", None, "high"),
                found(statement_row("2026-10-31", "SALARY", 9000000, "credit"), "income", Some("pay"), "high"),
            ],
            imported: false,
        };
        let mut s = s;
        s.rows[3].transfer_account_id = Some("card".into());
        STATEMENTS.lock().unwrap().get_or_insert_with(HashMap::new).insert("st_test".into(), s);

        // Row 3 is refiled, row 5 left out.
        let input = json!({ "statement_id": "st_test", "skip": [5], "changes": [{ "n": 3, "category_id": "food", "merchant": "Corner shop" }] });
        let (title, lines) = describe_change(&conn, "import_statement", &input).unwrap();
        assert_eq!(title, "Import 3 transactions into Bank from oct.pdf");
        assert!(lines.iter().any(|l| l == "1 row already in the book, left out"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "1 row skipped"), "{lines:?}");
        assert!(!lines.iter().any(|l| l.contains("Triage")), "{lines:?}");
        let card = change_card(&conn, "import_statement", &input).unwrap();
        assert_eq!((card.action, card.rows.len()), ("import", 3));
        assert!(card.notes.iter().any(|l| l == "1 row skipped"), "{:?}", card.notes);
        assert!(!card.notes.iter().any(|l| l.starts_with("20")), "{:?}", card.notes);

        let done = apply_change(&conn, "import_statement", &input).unwrap();
        assert_eq!(done["inserted"], 3);
        let shop: (String, Option<String>) = conn
            .query_row("SELECT kind, category_id FROM transactions WHERE merchant = 'Corner shop'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(shop, ("expense".into(), Some("food".into())));
        let transfer: (String, String, Option<String>) = conn
            .query_row("SELECT kind, account_id, to_account_id FROM transactions WHERE amount = 20000 AND merchant = 'CC PAYMENT'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!(transfer, ("transfer".into(), "a".into(), Some("card".into())));
        // Once is all.
        assert!(apply_change(&conn, "import_statement", &input).is_err());
    }

    #[test]
    fn chats_are_kept_listed_and_deleted() {
        let (_d, path) = book();
        let conn = db::open(&path).unwrap();
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        save_chat(&conn, "c1", "First question", &messages, &[]).unwrap();
        save_chat(&conn, "c2", "Second", &messages, &[json!({ "id": "tu" })]).unwrap();
        save_chat(&conn, "c1", "First question, renamed", &messages, &[]).unwrap();
        let list = list_chats(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "c1");
        let c2 = load_chat(&conn, "c2").unwrap();
        assert_eq!(c2.pending.len(), 1);
        rename_chat(&conn, "c2", "  Trip   costs ").unwrap();
        assert_eq!(load_chat(&conn, "c2").unwrap().title, "Trip costs");
        assert!(rename_chat(&conn, "c2", "   ").is_err());
        assert!(rename_chat(&conn, "gone", "x").is_err());
        delete_chat(&conn, "c1").unwrap();
        assert_eq!(list_chats(&conn).unwrap().len(), 1);
        assert!(load_chat(&conn, "c1").is_err());
        // The chat log is no business of the schema Claude is shown.
        let reader = open_reader(&path).unwrap();
        assert!(!schema(&reader).unwrap().contains("chats"));
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
