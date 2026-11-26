//! The phone's half of the book, as the Mac sees it.
//!
//! The Mac keeps the book of record. The phone keeps a copy and writes to it
//! freely, and every write it makes is also written down as an *op*: the
//! command the screen called and the arguments it called it with, appended
//! to a file of the phone's own in a folder both devices can see. The Mac
//! reads those files, applies each op through the same functions its own
//! screens use, and publishes a fresh copy of the book back to the folder.
//! `docs/companion.md` has the whole shape; this is the Mac's side of it,
//! plus the one piece both sides share, recording an op.
//!
//! Three things make an op mean the same on both sides:
//!
//! - **The same ids.** Applying an op on the phone hands out new ids; the op
//!   carries them, and the Mac hands the same ones out again in the same
//!   order. A transaction added on the phone is the same row on the Mac, so
//!   an edit to it made later on the phone still finds it.
//! - **The same time.** `now()` is pinned to the moment the op was made.
//! - **The same starting point.** Each row an op changes is hashed on the
//!   phone just before it is changed. If the Mac's row no longer hashes the
//!   same, it was changed somewhere else in the meantime, and the op waits
//!   in the conflicts table for a person rather than writing over it.
//!
//! Nothing here runs until a folder is set. With no `companion_dir`, the
//! Mac publishes nothing and reads nothing.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::db::{self, oops, Result};
use crate::models::*;

/// The folder the two devices share. Unset is off.
pub const DIR_SETTING: &str = "companion_dir";
/// How many snapshots have been published. Written into each snapshot, so a
/// copy always says which one it is.
const VERSION_SETTING: &str = "companion_version";
/// Per device, the last op applied: `companion_applied:<device>`.
const APPLIED_PREFIX: &str = "companion_applied:";

pub const SNAPSHOT: &str = "book.sqlite3";
pub const SNAPSHOT_META: &str = "book.json";
pub const OPS_DIR: &str = "ops";

// ------------------------------------------------------------------ pinning

struct Pin {
    /// Ids to hand out before making new ones, in order.
    ids: VecDeque<String>,
    /// What `now()` says while pinned.
    at: Option<String>,
    /// Every id handed out while pinned, given or made.
    issued: Vec<String>,
}

thread_local! {
    static PIN: RefCell<Option<Pin>> = const { RefCell::new(None) };
}

/// The next id: the next one the op brought with it, or a fresh one. Called
/// by `db::new_id`, so every id the book makes comes through here.
pub(crate) fn issue_id(fresh: impl FnOnce() -> String) -> String {
    PIN.with(|pin| match pin.borrow_mut().as_mut() {
        Some(p) => {
            let id = p.ids.pop_front().unwrap_or_else(fresh);
            p.issued.push(id.clone());
            id
        }
        None => fresh(),
    })
}

/// The time: the op's own while one is being applied. Called by `db::now`.
pub(crate) fn issue_now(fresh: impl FnOnce() -> String) -> String {
    PIN.with(|pin| match pin.borrow().as_ref().and_then(|p| p.at.clone()) {
        Some(at) => at,
        None => fresh(),
    })
}

/// Runs `f` with ids and the time pinned, and says which ids it took.
fn pinned<T>(ids: Vec<String>, at: Option<String>, f: impl FnOnce() -> T) -> (T, Vec<String>) {
    PIN.with(|pin| {
        *pin.borrow_mut() = Some(Pin { ids: ids.into(), at, issued: Vec::new() })
    });
    let out = f();
    let issued = PIN.with(|pin| pin.borrow_mut().take().map(|p| p.issued).unwrap_or_default());
    (out, issued)
}

// ------------------------------------------------------------------- hashes

/// The tables an op can name a row of. Ops arrive from a file, so the table
/// name is checked against this before it goes anywhere near SQL.
const TABLES: &[&str] = &["transactions", "debts", "debt_payments", "debt_additions", "plans"];

/// A row as it stands, reduced to a short fingerprint: FNV-1a over every
/// column in order. `None` when there is no such row. Stable across
/// machines and Rust versions, which a std hasher is not promised to be.
pub fn row_hash(conn: &Connection, table: &str, id: &str) -> Result<Option<String>> {
    if !TABLES.contains(&table) {
        return Err(format!("Not a table an op can change: {table}"));
    }
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} WHERE id = ?1"))
        .map_err(oops)?;
    let columns = stmt.column_count();
    stmt.query_row(params![id], |row| {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for i in 0..columns {
            let cell = match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => "\u{0}".to_string(),
                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                rusqlite::types::ValueRef::Real(f) => f.to_string(),
                rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                rusqlite::types::ValueRef::Blob(b) => format!("{b:?}"),
            };
            for byte in cell.bytes().chain(std::iter::once(0x1f)) {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        }
        Ok(format!("{hash:016x}"))
    })
    .optional()
    .map_err(oops)
}

// ---------------------------------------------------------------------- ops

/// One row an op changes, and what it looked like just before.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Base {
    pub table: String,
    pub id: String,
    pub hash: Option<String>,
}

/// One write made on the phone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Op {
    pub seq: u64,
    pub at: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub base: Vec<Base>,
}

/// The commands the phone can send. Anything else is refused on the phone
/// before it is queued, and held for a person if one turns up anyway.
// The phone's side; the Mac build only reads what it writes.
#[allow(dead_code)]
pub const COMMANDS: &[&str] = &[
    "save_transaction",
    "delete_transaction",
    "delete_transactions",
    "update_transactions",
    "label_transactions",
    "save_debt",
    "delete_debt",
    "save_debt_payment",
    "delete_debt_payment",
    "save_debt_addition",
    "delete_debt_addition",
    "save_person_repayment",
    "delete_person_repayment",
    "pay_plan",
    "skip_plan",
];

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("{key}: {e}"))
}

// The phone's side; the Mac build only reads what it writes.
#[allow(dead_code)]
fn input_id(args: &Value) -> Option<String> {
    args.get("input")?.get("id")?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// The existing rows an op is about to change, by table and id.
// The phone's side; the Mac build only reads what it writes.
#[allow(dead_code)]
fn targets(cmd: &str, args: &Value) -> Vec<(&'static str, String)> {
    let one = |table: &'static str, id: Option<String>| id.map(|id| vec![(table, id)]).unwrap_or_default();
    let many = |table: &'static str| -> Vec<(&'static str, String)> {
        args.get("ids")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(|v| v.as_str()).map(|id| (table, id.to_string())).collect())
            .unwrap_or_default()
    };
    let id = || args.get("id").and_then(Value::as_str).map(String::from);
    match cmd {
        "save_transaction" => one("transactions", input_id(args)),
        "delete_transaction" => one("transactions", id()),
        "delete_transactions" | "update_transactions" | "label_transactions" => many("transactions"),
        "save_debt" => one("debts", input_id(args)),
        "delete_debt" => one("debts", id()),
        "save_debt_payment" => one("debt_payments", input_id(args)),
        "delete_debt_payment" => one("debt_payments", id()),
        "save_debt_addition" => one("debt_additions", input_id(args)),
        "delete_debt_addition" => one("debt_additions", id()),
        "pay_plan" | "skip_plan" => one("plans", id()),
        _ => Vec::new(),
    }
}

/// Runs one command against a book. The same call on the phone's copy and
/// on the Mac's book; what each command does is the book's business.
fn run(conn: &Connection, cmd: &str, args: &Value) -> Result<Value> {
    let out = match cmd {
        "save_transaction" => json!(db::save_transaction(conn, arg(args, "input")?)?),
        "delete_transaction" => json!(db::delete_transaction(conn, &arg::<String>(args, "id")?)?),
        "delete_transactions" => {
            json!(db::delete_transactions(conn, &arg::<Vec<String>>(args, "ids")?)?)
        }
        "update_transactions" => json!(db::update_transactions(
            conn,
            &arg::<Vec<String>>(args, "ids")?,
            arg::<TransactionPatch>(args, "patch")?,
        )?),
        "label_transactions" => json!(db::label_transactions(
            conn,
            &arg::<Vec<String>>(args, "ids")?,
            &arg::<String>(args, "labelId")?,
            arg::<bool>(args, "on")?,
        )?),
        "save_debt" => json!(db::save_debt(conn, arg(args, "input")?)?),
        "delete_debt" => json!(db::delete_debt(conn, &arg::<String>(args, "id")?)?),
        "save_debt_payment" => json!(db::save_debt_payment(conn, arg(args, "input")?)?),
        "delete_debt_payment" => json!(db::delete_debt_payment(conn, &arg::<String>(args, "id")?)?),
        "save_debt_addition" => json!(db::save_debt_addition(conn, arg(args, "input")?)?),
        "delete_debt_addition" => {
            json!(db::delete_debt_addition(conn, &arg::<String>(args, "id")?)?)
        }
        "save_person_repayment" => json!(db::save_person_repayment(conn, arg(args, "input")?)?),
        "delete_person_repayment" => {
            json!(db::delete_person_repayment(conn, &arg::<String>(args, "id")?)?)
        }
        "pay_plan" => json!(crate::plans::pay_plan(
            conn,
            &arg::<String>(args, "id")?,
            arg(args, "input")?,
        )?),
        "skip_plan" => json!(crate::plans::skip_plan(conn, &arg::<String>(args, "id")?)?),
        _ => return Err(format!("The phone can't do {cmd} yet.")),
    };
    Ok(out)
}

/// Runs `f` inside a savepoint: all of it lands or none of it does.
fn atomically<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("SAVEPOINT companion_op").map_err(oops)?;
    match f() {
        Ok(v) => {
            conn.execute_batch("RELEASE companion_op").map_err(oops)?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO companion_op; RELEASE companion_op");
            Err(e)
        }
    }
}

// The phone's side; the Mac build only reads what it writes.
#[allow(dead_code)]
fn ops_file(dir: &Path, device: &str) -> PathBuf {
    dir.join(OPS_DIR).join(format!("{device}.jsonl"))
}

fn read_ops(path: &Path) -> Result<Vec<Op>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(oops(e)),
    };
    let mut ops = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Op>(line) {
            Ok(op) => ops.push(op),
            // A line iCloud is still writing. Stop here and pick the rest up
            // next time, rather than skip past it and lose its place.
            Err(_) => break,
        }
    }
    Ok(ops)
}

/// The phone's side: applies a command to its own copy and queues it for
/// the Mac. Returns what the command returned, as the screen expects.
// The phone's side; the Mac build only reads what it writes.
#[allow(dead_code)]
pub fn record(conn: &Connection, dir: &Path, device: &str, cmd: &str, args: Value) -> Result<Value> {
    if !COMMANDS.contains(&cmd) {
        return Err(format!("The phone can't do {cmd} yet."));
    }
    let base = targets(cmd, &args)
        .into_iter()
        .map(|(table, id)| Ok(Base { table: table.into(), hash: row_hash(conn, table, &id)?, id }))
        .collect::<Result<Vec<_>>>()?;
    let at = db::now();
    let (out, ids) = pinned(Vec::new(), Some(at.clone()), || atomically(conn, || run(conn, cmd, &args)));
    let out = out?;

    let path = ops_file(dir, device);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(oops)?;
    let seq = read_ops(&path)?.last().map(|op| op.seq).unwrap_or(0) + 1;
    let op = Op { seq, at, cmd: cmd.into(), args, ids, base };
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(oops)?;
    writeln!(file, "{}", serde_json::to_string(&op).map_err(oops)?).map_err(oops)?;
    Ok(out)
}

// ---------------------------------------------------------------- conflicts

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS companion_conflicts (
            id          TEXT PRIMARY KEY,
            device      TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            op          TEXT NOT NULL,
            reason      TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            resolved    TEXT
        );",
    )
    .map_err(oops)
}

/// A change from the phone that was not applied, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub device: String,
    pub seq: u64,
    pub cmd: String,
    pub args: Value,
    pub reason: String,
    pub created_at: String,
}

fn hold(conn: &Connection, device: &str, op: &Op, reason: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO companion_conflicts (id, device, seq, op, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            device,
            op.seq as i64,
            serde_json::to_string(op).map_err(oops)?,
            reason,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(oops)?;
    Ok(())
}

/// The changes still waiting on a person, oldest first.
pub fn conflicts(conn: &Connection) -> Result<Vec<Conflict>> {
    ensure_schema(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, device, seq, op, reason, created_at FROM companion_conflicts
             WHERE resolved IS NULL ORDER BY created_at, seq",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?))
        })
        .map_err(oops)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, device, seq, op, reason, created_at) = row.map_err(oops)?;
        let op: Op = serde_json::from_str(&op).map_err(oops)?;
        out.push(Conflict { id, device, seq: seq as u64, cmd: op.cmd, args: op.args, reason, created_at });
    }
    Ok(out)
}

/// Settles one held change: `accept` applies it over the row as it now is,
/// otherwise it is dropped. Either way it leaves the inbox.
pub fn resolve(conn: &Connection, id: &str, accept: bool) -> Result<()> {
    ensure_schema(conn)?;
    let op: String = conn
        .query_row(
            "SELECT op FROM companion_conflicts WHERE id = ?1 AND resolved IS NULL",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(oops)?
        .ok_or("That change has already been settled.")?;
    let op: Op = serde_json::from_str(&op).map_err(oops)?;
    if accept {
        let (out, _) = pinned(op.ids.clone(), Some(op.at.clone()), || {
            atomically(conn, || run(conn, &op.cmd, &op.args))
        });
        out?;
    }
    conn.execute(
        "UPDATE companion_conflicts SET resolved = ?2 WHERE id = ?1",
        params![id, if accept { "accepted" } else { "dropped" }],
    )
    .map_err(oops)?;
    Ok(())
}

// -------------------------------------------------------------------- apply

/// What one pass over the queue did.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub applied: u64,
    pub held: u64,
}

fn applied_through(conn: &Connection, device: &str) -> Result<u64> {
    Ok(db::setting(conn, &format!("{APPLIED_PREFIX}{device}"))?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0))
}

/// Every device's queue, applied in order from where each was left. A row
/// that changed underneath an op, or an op the book refuses, is held in
/// the conflicts table; either way the queue moves past it, so one stuck
/// change never stops the ones behind it.
pub fn apply(conn: &Connection, dir: &Path) -> Result<Applied> {
    ensure_schema(conn)?;
    let mut done = Applied::default();
    let entries = match std::fs::read_dir(dir.join(OPS_DIR)) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(done),
        Err(e) => return Err(oops(e)),
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();

    for path in files {
        let device = path.file_stem().unwrap().to_string_lossy().into_owned();
        let from = applied_through(conn, &device)?;
        for op in read_ops(&path)?.into_iter().filter(|op| op.seq > from) {
            let moved = op.base.iter().find_map(|b| match row_hash(conn, &b.table, &b.id) {
                Ok(now) if now == b.hash => None,
                Ok(None) => Some("It was deleted on the Mac before this arrived.".to_string()),
                Ok(Some(_)) => Some("It was changed on the Mac before this arrived.".to_string()),
                Err(e) => Some(e),
            });
            let held = match moved {
                Some(reason) => Some(reason),
                None => {
                    let (out, _) = pinned(op.ids.clone(), Some(op.at.clone()), || {
                        atomically(conn, || run(conn, &op.cmd, &op.args))
                    });
                    out.err()
                }
            };
            match held {
                Some(reason) => {
                    hold(conn, &device, &op, &reason)?;
                    done.held += 1;
                }
                None => done.applied += 1,
            }
            db::set_setting(conn, &format!("{APPLIED_PREFIX}{device}"), &op.seq.to_string())?;
        }
    }
    Ok(done)
}

// ------------------------------------------------------------------ publish

/// What a published snapshot says about itself, beside it in `book.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u64,
    pub taken_at: String,
    /// Per device, the last of its ops this snapshot already holds.
    pub applied: BTreeMap<String, u64>,
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// Writes the whole book to the folder for the phone to read. The copy is
/// made beside the old one and renamed over it, so a reader only ever sees
/// a whole snapshot, the old one or the new.
pub fn publish(conn: &Connection, dir: &Path) -> Result<Snapshot> {
    std::fs::create_dir_all(dir).map_err(oops)?;
    let version = db::setting(conn, VERSION_SETTING)?
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        + 1;
    // Into the book before the copy, so the copy carries its own number.
    db::set_setting(conn, VERSION_SETTING, &version.to_string())?;

    let mut applied = BTreeMap::new();
    for (key, value) in db::settings(conn)? {
        if let Some(device) = key.strip_prefix(APPLIED_PREFIX) {
            applied.insert(device.to_string(), value.parse().unwrap_or(0));
        }
    }
    let snapshot = Snapshot { version, taken_at: chrono::Utc::now().to_rfc3339(), applied };

    let tmp = dir.join(format!(".{SNAPSHOT}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    conn.execute_batch(&format!("VACUUM INTO {}", quoted(&tmp))).map_err(oops)?;
    std::fs::rename(&tmp, dir.join(SNAPSHOT)).map_err(oops)?;

    let meta_tmp = dir.join(format!(".{SNAPSHOT_META}.tmp"));
    std::fs::write(&meta_tmp, serde_json::to_vec_pretty(&snapshot).map_err(oops)?).map_err(oops)?;
    std::fs::rename(&meta_tmp, dir.join(SNAPSHOT_META)).map_err(oops)?;
    Ok(snapshot)
}

/// The folder, when one is set.
pub fn dir(conn: &Connection) -> Result<Option<PathBuf>> {
    Ok(db::setting(conn, DIR_SETTING)?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from))
}

/// Where the companion stands, for Settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub dir: Option<String>,
    pub version: u64,
    pub applied: BTreeMap<String, u64>,
    pub conflicts: usize,
}

pub fn status(conn: &Connection) -> Result<Status> {
    let mut applied = BTreeMap::new();
    for (key, value) in db::settings(conn)? {
        if let Some(device) = key.strip_prefix(APPLIED_PREFIX) {
            applied.insert(device.to_string(), value.parse().unwrap_or(0));
        }
    }
    Ok(Status {
        dir: dir(conn)?.map(|d| d.to_string_lossy().into_owned()),
        version: db::setting(conn, VERSION_SETTING)?.and_then(|s| s.parse().ok()).unwrap_or(0),
        applied,
        conflicts: conflicts(conn)?.len(),
    })
}

/// One round: take in what the phone sent, then publish what the book now
/// is. Nothing at all when no folder is set.
pub fn sync(conn: &Connection) -> Result<Option<Applied>> {
    let Some(dir) = dir(conn)? else { return Ok(None) };
    let done = apply(conn, &dir)?;
    publish(conn, &dir)?;
    Ok(Some(done))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flow-companion-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The phone's copy: whatever the Mac last published, opened as a book.
    fn phone_copy(dir: &Path, name: &str) -> Connection {
        let local = folder(name).join("local.sqlite3");
        std::fs::copy(dir.join(SNAPSHOT), &local).unwrap();
        db::open(&local).unwrap()
    }

    fn account(conn: &Connection) -> String {
        db::save_account(
            conn,
            AccountInput {
                id: None,
                name: "HDFC".into(),
                kind: "bank".into(),
                institution: None,
                opening_balance: 10_000_00,
                color: "#000000".into(),
                icon: "wallet".into(),
            },
        )
        .unwrap()
        .id
    }

    fn spend(account: &str, id: Option<&str>, merchant: &str, amount: Paise) -> Value {
        json!({ "input": {
            "id": id, "kind": "expense", "amount": amount, "accountId": account,
            "toAccountId": null, "categoryId": null, "merchant": merchant, "note": null,
            "occurredAt": "2026-11-20T10:00", "splits": null, "shares": null,
        }})
    }

    fn merchant(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row("SELECT merchant FROM transactions WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .unwrap()
    }

    #[test]
    fn publishing_writes_a_whole_book_that_says_which_one_it_is() {
        let mac = book();
        account(&mac);
        let dir = folder("publish");
        let first = publish(&mac, &dir).unwrap();
        let second = publish(&mac, &dir).unwrap();
        assert_eq!((first.version, second.version), (1, 2));

        let copy = phone_copy(&dir, "publish-phone");
        assert_eq!(db::setting(&copy, VERSION_SETTING).unwrap().as_deref(), Some("2"));
        assert_eq!(db::list_accounts(&copy).unwrap().len(), 1);
        let meta: Snapshot =
            serde_json::from_slice(&std::fs::read(dir.join(SNAPSHOT_META)).unwrap()).unwrap();
        assert_eq!(meta, second);
    }

    #[test]
    fn a_transaction_added_on_the_phone_is_the_same_row_on_the_mac() {
        let mac = book();
        let hdfc = account(&mac);
        let dir = folder("add");
        publish(&mac, &dir).unwrap();

        let phone = phone_copy(&dir, "add-phone");
        let made = record(&phone, &dir, "iphone", "save_transaction", spend(&hdfc, None, "Blue Tokai", 450_00))
            .unwrap();
        let id = made["id"].as_str().unwrap().to_string();

        assert_eq!(apply(&mac, &dir).unwrap(), Applied { applied: 1, held: 0 });
        assert_eq!(merchant(&mac, &id).as_deref(), Some("Blue Tokai"));
        // The same row, to the byte: same id, same time stamped on it.
        assert_eq!(
            row_hash(&mac, "transactions", &id).unwrap(),
            row_hash(&phone, "transactions", &id).unwrap()
        );

        // Applied once, however often the queue is read.
        assert_eq!(apply(&mac, &dir).unwrap(), Applied::default());
        let snap = publish(&mac, &dir).unwrap();
        assert_eq!(snap.applied.get("iphone"), Some(&1));
    }

    #[test]
    fn an_edit_on_the_phone_to_a_row_it_added_still_finds_it() {
        let mac = book();
        let hdfc = account(&mac);
        let dir = folder("chain");
        publish(&mac, &dir).unwrap();

        let phone = phone_copy(&dir, "chain-phone");
        let made = record(&phone, &dir, "iphone", "save_transaction", spend(&hdfc, None, "Swigy", 300_00))
            .unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        record(&phone, &dir, "iphone", "save_transaction", spend(&hdfc, Some(&id), "Swiggy", 300_00))
            .unwrap();

        assert_eq!(apply(&mac, &dir).unwrap(), Applied { applied: 2, held: 0 });
        assert_eq!(merchant(&mac, &id).as_deref(), Some("Swiggy"));
    }

    #[test]
    fn an_edit_to_a_row_the_mac_changed_meanwhile_waits_for_a_person() {
        let mac = book();
        let hdfc = account(&mac);
        let tx = db::save_transaction(&mac, serde_json::from_value(spend(&hdfc, None, "Uber", 200_00)["input"].clone()).unwrap())
            .unwrap()
            .id;
        let dir = folder("clash");
        publish(&mac, &dir).unwrap();

        let phone = phone_copy(&dir, "clash-phone");
        record(&phone, &dir, "iphone", "save_transaction", spend(&hdfc, Some(&tx), "Uber trip", 200_00))
            .unwrap();
        db::save_transaction(&mac, serde_json::from_value(spend(&hdfc, Some(&tx), "Uber Eats", 200_00)["input"].clone()).unwrap())
            .unwrap();

        assert_eq!(apply(&mac, &dir).unwrap(), Applied { applied: 0, held: 1 });
        assert_eq!(merchant(&mac, &tx).as_deref(), Some("Uber Eats"));

        let held = conflicts(&mac).unwrap();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].cmd, "save_transaction");

        resolve(&mac, &held[0].id, true).unwrap();
        assert_eq!(merchant(&mac, &tx).as_deref(), Some("Uber trip"));
        assert!(conflicts(&mac).unwrap().is_empty());
    }

    #[test]
    fn a_change_the_book_refuses_is_held_and_the_queue_moves_on() {
        let mac = book();
        let hdfc = account(&mac);
        let dir = folder("refuse");
        publish(&mac, &dir).unwrap();

        // Written by hand: the phone would refuse a zero amount itself, but
        // a file is a file.
        let ops = dir.join(OPS_DIR);
        std::fs::create_dir_all(&ops).unwrap();
        let bad = Op { seq: 1, at: db::now(), cmd: "save_transaction".into(),
            args: spend(&hdfc, None, "Nothing", 0), ids: vec![], base: vec![] };
        let unknown = Op { seq: 2, at: db::now(), cmd: "reset_all".into(), args: json!({}), ids: vec![], base: vec![] };
        let good = Op { seq: 3, at: db::now(), cmd: "save_transaction".into(),
            args: spend(&hdfc, None, "Metro", 40_00), ids: vec!["fixed-id".into()], base: vec![] };
        let lines: Vec<String> = [bad, unknown, good].iter().map(|o| serde_json::to_string(o).unwrap()).collect();
        // And half a line at the end, the way iCloud can leave one mid-sync.
        std::fs::write(ops.join("iphone.jsonl"), format!("{}\n{{\"seq\": 4, \"at", lines.join("\n"))).unwrap();

        assert_eq!(apply(&mac, &dir).unwrap(), Applied { applied: 1, held: 2 });
        assert_eq!(merchant(&mac, "fixed-id").as_deref(), Some("Metro"));
        assert_eq!(applied_through(&mac, "iphone").unwrap(), 3);
    }

    #[test]
    fn with_no_folder_set_nothing_is_published_or_read() {
        let mac = book();
        assert_eq!(sync(&mac).unwrap(), None);
        assert_eq!(status(&mac).unwrap().version, 0);
    }
}
