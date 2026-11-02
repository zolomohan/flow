//! Spoken captures: a sentence said to Siri, landed in the book.
//!
//! A Shortcut on the phone dictates a line — "spent four fifty at Blue Tokai
//! on the HDFC card" — and appends it to a file in iCloud Drive. Nothing here
//! talks to Siri, and nothing here needs to: by the time Midas is involved,
//! the sentence is a line of text sitting in a file, and the only questions
//! left are what it says and whether the book can act on it unaided.
//!
//! The transport is a file rather than a server on purpose. A file syncs when
//! the Mac is shut, needs no account and no port, and cannot lose a capture
//! because something was not running. Each device only ever appends, so there
//! is never a merge to lose an argument with.
//!
//! Two things are deliberately *not* trusted. The first is the phone's guess:
//! the on-device model can be asked to pull the fields out, and when it has,
//! its answer arrives alongside the sentence rather than instead of it, so a
//! bad reading can be corrected against the original words. The second is the
//! resolution itself — a capture becomes a posting only when the amount and
//! the account are both certain, and then it wears the Siri label — a note
//! of where it came from rather than a queue to be worked through, so it
//! stays on. Everything else waits in the Inbox for a person.

use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, Weekday};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::PathBuf;

use crate::db::{self, new_id, now, oops, Result};
use crate::models::*;

/// What Midas writes beside the drop for the phone to read: the book in
/// prose, for a model to be prompted with, and the book as data, for a
/// shortcut to build its pickers out of. Named to sit beside the drop file
/// rather than to describe either reader, because both are the same book.
/// The first question's way through to the saved templates. It stands for no
/// entry of its own — picking it asks a second question instead.
pub const TEMPLATES_CHOICE: &str = "Templates…";

pub const BOOK_TEXT: &str = "midas-book.txt";
pub const BOOK_JSON: &str = "midas-book.json";

/// Where the Shortcut leaves its lines. Overridable, because iCloud Drive is
/// where it goes by default and not where it has to go.
pub const INBOX_SETTING: &str = "capture_inbox";

/// Who the people in your sentences are, and where money with them is filed.
///
/// Free text, written into the word list verbatim and read by the phone as
/// part of its prompt. It lives in the book rather than in the prompt because
/// it is yours and it changes — a prompt baked into a shortcut can only be
/// corrected by building a new shortcut.
pub const PEOPLE_SETTING: &str = "capture_people";

/// The default drop: the Shortcuts app's own iCloud container.
///
/// Not a folder of ours in iCloud Drive, which is what this first reached
/// for. A Shortcut's "Append to File" resolves its path against this
/// container and nowhere else, so a path anywhere outside it silently
/// appends nothing. It surfaces in Files and in Finder as iCloud Drive >
/// Shortcuts, and it is the one place a Shortcut can write to on every
/// device without being handed a permission first.
#[cfg(not(target_os = "ios"))]
fn default_inbox() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join("Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents")
        // The extension matches what a Shortcut actually writes, so it has no
        // reason to rename the file and every append lands on the same one.
        .join("midas-inbox.json")
}

/// The same drop on a phone, which cannot be the same path.
///
/// `$HOME` on iOS is the app's own sandbox container, so the Mac's default
/// resolves to a directory that cannot exist — and an inbox that cannot exist
/// reads as an inbox that is empty, silently and forever. Worse, one iOS app
/// may not read another's iCloud container at all, so the Shortcuts folder is
/// not a permission away from working here; it is closed.
///
/// What is open is our own Documents directory. With `UIFileSharingEnabled`
/// and `LSSupportsOpeningDocumentsInPlace` set, it appears in Files as
/// "On My iPhone > flow", which a Shortcut's *Save File* can be pointed at —
/// the same append, the same queue, the same lines, one directory over.
#[cfg(target_os = "ios")]
fn default_inbox() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Documents").join("midas-inbox.json")
}

pub fn inbox_path(conn: &Connection) -> PathBuf {
    match db::setting(conn, INBOX_SETTING) {
        Ok(Some(p)) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => default_inbox(),
    }
}

/// Every file the drop might actually be.
///
/// Shortcuts renames as it writes: append JSON to `midas-inbox.jsonl` and it
/// lands as `midas-inbox.jsonl.json`, because the app types the content and
/// corrects the extension behind you. What it decides is not ours to predict
/// and not worth reinstalling a shortcut over, so every sibling whose name
/// begins with the one we asked for is read. They are all the same queue.
fn inbox_files(conn: &Connection) -> Vec<PathBuf> {
    let path = inbox_path(conn);
    let (Some(dir), Some(stem)) = (path.parent(), path.file_name()) else {
        return vec![path];
    };
    // Everything before the first dot. Shortcuts does not only correct the
    // extension — it numbers a file it declines to append to, so one drop can
    // arrive as midas-inbox.jsonl.json and midas-inbox.jsonl-2.json. The stem
    // is the only part of the name it leaves alone.
    let stem = stem.to_string_lossy();
    let stem = stem.split('.').next().unwrap_or(&stem).to_string();
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&stem))
                .unwrap_or(false)
        })
        .collect();
    // Read in a fixed order, so a line's place in the queue is the same on
    // every sync however the directory happens to enumerate.
    found.sort();
    if found.is_empty() {
        found.push(path);
    }
    found
}

/// The word list the Shortcut reads into its prompt, kept beside the inbox.
pub fn book_text_path(conn: &Connection) -> PathBuf {
    inbox_path(conn).with_file_name(BOOK_TEXT)
}

/// The same book, shaped for a shortcut rather than for a model.
///
/// A prompt wants prose; a picker wants a list. Shortcuts can turn JSON into
/// something it can look keys up in, which is the only way a generated
/// shortcut can build its lists at run time — carving them out of text needs
/// a Split Text action that will not take a separator we can spell.
pub fn book_json_path(conn: &Connection) -> PathBuf {
    inbox_path(conn).with_file_name(BOOK_JSON)
}

/* ------------------------------------------------------------- the book */

/// How many counterparties the phone is told about.
///
/// The whole list runs to hundreds and would crowd out the sentence itself.
/// The ones you deal with often are the ones a model has any chance of
/// mishearing into a near-miss, and the rest are caught on the way in by
/// matching against every name this book holds.
const MERCHANTS_OFFERED: usize = 60;

/// What the phone needs to know about this book to describe a posting in its
/// own terms: the accounts money can come out of, the categories it can be
/// filed under, and who it has been with before. Three sections divided by a
/// rule, read apart by the Shortcut and dropped into the prompt.
///
/// Archived accounts are left out. They cannot take a new posting, so naming
/// them to the model only invites it to pick one.
pub fn book_text(conn: &Connection) -> Result<String> {
    let mut out = String::new();
    let mut stmt = conn
        .prepare("SELECT name FROM accounts WHERE archived = 0 ORDER BY sort_order")
        .map_err(oops)?;
    for name in stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?
    {
        out.push_str(&name);
        out.push('\n');
    }
    out.push_str("---\n");

    // A heading is not a filing. Only what a posting could actually be put
    // under is offered, or the model spends its guesses on group names the
    // ledger would refuse anyway.
    let mut stmt = conn
        .prepare(&format!(
            "{FILEABLE} ORDER BY c.kind, COALESCE(p.name, c.name), c.sort_order"
        ))
        .map_err(oops)?;
    for (group, leaf) in stmt
        .query_map([], |r| {
            Ok((r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?
    {
        match group {
            Some(group) => out.push_str(&format!("{group} > {leaf}\n")),
            // A book whose categories are a flat list says them plainly.
            None => out.push_str(&format!("{leaf}\n")),
        }
    }
    out.push_str("---\n");

    for name in known_merchants(conn, Some(MERCHANTS_OFFERED))? {
        out.push_str(&name);
        out.push('\n');
    }
    out.push_str("---\n");

    // Verbatim: this section is prose the model reads, not a list this book
    // has any opinion about.
    if let Some(people) = db::setting(conn, PEOPLE_SETTING)? {
        out.push_str(people.trim());
        out.push('\n');
    }
    Ok(out)
}

/// Everyone this book has recorded money with, most seen first.
///
/// Transfers are left out: their merchant is bookkeeping — "Transfer",
/// "Transfer (unmatched)" — rather than anybody you paid, and offering those
/// as names to match against would only invite a coffee to become a transfer.
pub fn known_merchants(conn: &Connection, limit: Option<usize>) -> Result<Vec<String>> {
    let sql = format!(
        "SELECT merchant, COUNT(*) AS seen FROM transactions
         WHERE kind <> 'transfer' AND TRIM(merchant) <> ''
         GROUP BY LOWER(TRIM(merchant))
         ORDER BY seen DESC, merchant{}",
        limit.map(|n| format!(" LIMIT {n}")).unwrap_or_default()
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

/// Writes the list out for the Shortcut to read. Called after anything that
/// could change it, so opening an account is enough to teach the phone about
/// it — there is no second thing to remember to do.
///
/// Failure is not an error worth stopping a save for: the folder may not
/// exist on a machine with iCloud Drive turned off, and a book that cannot
/// write its book file is still a book.
pub fn write_book(conn: &Connection) -> Result<PathBuf> {
    let path = book_text_path(conn);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(oops)?;
    }
    std::fs::write(&path, book_text(conn)?).map_err(oops)?;
    std::fs::write(book_json_path(conn), book_json(conn)?).map_err(oops)?;
    Ok(path)
}

/// The book as a shortcut's pickers need it.
///
/// * `accounts` — what money can come out of.
/// * `kinds` — what the second question offers, by what the first answered.
///   A transfer has no category, so its second question is where it went.
/// * `groups` — what the third offers, by what the second answered. Accounts
///   answer with themselves: there is nothing under one, and a list of one
///   reads as confirming the destination rather than as a dead end.
pub fn book_json(conn: &Connection) -> Result<String> {
    use serde_json::{json, Map, Value};

    let mut accounts = Vec::new();
    let mut stmt = conn
        .prepare("SELECT name FROM accounts WHERE archived = 0 ORDER BY sort_order")
        .map_err(oops)?;
    for name in stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?
    {
        accounts.push(name);
    }

    // Every filing, with the heading it sits under and the direction of money
    // it belongs to. A top-level category nobody has given children to is its
    // own group, so a flat book still gets two working questions.
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(p.name, c.name), c.name, c.kind
             FROM categories c
             LEFT JOIN categories p ON p.id = c.parent_id
             WHERE c.parent_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id)
             ORDER BY COALESCE(p.name, c.name), c.sort_order",
        )
        .map_err(oops)?;
    let leaves: Vec<(String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let mut groups: Map<String, Value> = Map::new();
    let mut expense: Vec<String> = Vec::new();
    let mut income: Vec<String> = Vec::new();
    for (group, sub, kind) in &leaves {
        let bucket = if kind == "income" { &mut income } else { &mut expense };
        if !bucket.contains(group) {
            bucket.push(group.clone());
        }
        groups
            .entry(group.clone())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("a group's subs are a list")
            .push(json!(sub));
    }
    for account in &accounts {
        groups.insert(account.clone(), json!([account]));
    }

    // What the first question offers, and what each answer to it already
    // knows. The three directions of money answer nothing and ask for
    // everything; a template answers as much as it was saved with.
    //
    // Each entry carries an `ask` flag per field rather than an empty value,
    // so the shortcut can branch on a word instead of on emptiness — and the
    // value itself stays clean enough to write straight into the payload.
    let blank = |kind: &str| {
        json!({
            "kind": kind,
            "amount": "", "askAmount": "yes",
            "account": "", "askAccount": "yes",
            "group": "", "sub": "", "askCategory": "yes",
            "merchant": "", "askMerchant": "yes",
            "note": "", "askNote": "yes",
        })
    };
    let directions: Vec<String> = ["Expense", "Income", "Transfer"]
        .iter()
        .map(|k| k.to_string())
        .collect();
    let mut templates: Map<String, Value> = Map::new();
    for kind in &directions {
        templates.insert(kind.clone(), blank(kind));
    }
    let mut names: Vec<String> = Vec::new();

    let mut stmt = conn
        .prepare(
            "SELECT t.name, t.kind, t.amount, a.name, p.name, c.name, t.merchant,
                     COALESCE(t.note, '')
             FROM transaction_templates t
             LEFT JOIN accounts a ON a.id = t.account_id AND a.archived = 0
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN categories p ON p.id = c.parent_id
             ORDER BY t.used_count DESC, t.name",
        )
        .map_err(oops)?;
    let saved = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Paise>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    for (name, kind, amount, account, group, sub, merchant, note) in saved {
        // A name already spoken for by a direction of money would shadow it
        // in the first question, and the direction has to stay reachable.
        if templates.contains_key(&name) {
            continue;
        }
        let kind = match kind.as_str() {
            "income" => "Income",
            "transfer" => "Transfer",
            _ => "Expense",
        };
        // A template that carries no figure, or whose account or category has
        // been deleted out from under it, asks for that part like any other.
        let filed = group.is_some() && sub.is_some();
        templates.insert(
            name.clone(),
            json!({
                "kind": kind,
                "amount": if amount > 0 { format!("{}", amount as f64 / 100.0) } else { String::new() },
                "askAmount": if amount > 0 { "no" } else { "yes" },
                "account": account.clone().unwrap_or_default(),
                "askAccount": if account.is_some() { "no" } else { "yes" },
                "group": group.unwrap_or_default(),
                "sub": sub.unwrap_or_default(),
                "askCategory": if filed { "no" } else { "yes" },
                "merchant": merchant.trim(),
                "askMerchant": if merchant.trim().is_empty() { "yes" } else { "no" },
                "note": note.trim(),
                "askNote": if note.trim().is_empty() { "yes" } else { "no" },
            }),
        );
        names.push(name);
    }

    // The first question offers the three directions of money, and a way
    // through to the templates when there are any. The second only happens on
    // that last answer.
    //
    // `keys` is how the two paths rejoin: it maps each first answer to the
    // entry it stands for, and maps the way-through to nothing at all — so
    // the key to look up is that value followed by whatever the second
    // question returned, and exactly one of the two ever holds anything.
    let mut starts = directions.clone();
    let mut keys: Map<String, Value> = Map::new();
    for kind in &directions {
        keys.insert(kind.clone(), json!(kind));
    }
    if !names.is_empty() {
        starts.push(TEMPLATES_CHOICE.to_string());
        keys.insert(TEMPLATES_CHOICE.to_string(), json!(""));
    }

    serde_json::to_string_pretty(&json!({
        "accounts": accounts,
        "kinds": {"Expense": expense, "Income": income, "Transfer": accounts},
        "groups": groups,
        "starts": starts,
        "keys": keys,
        "templateNames": names,
        "templates": templates,
    }))
    .map_err(oops)
}



/* ------------------------------------------------------- reading the drop */

/// One line as the phone left it: the sentence, when it was said, and
/// whatever the on-device model made of it before it got here.
#[derive(Default, Debug)]
struct Spoken {
    said: String,
    /// The line exactly as it was written, JSON and all.
    raw: String,
    at: Option<String>,
    source: String,
    hints: Hints,
}

/// The model's reading. Every field is a maybe — the prompt asks for null
/// over a guess, and an older Shortcut sends none of them at all.
#[derive(Default, Debug)]
struct Hints {
    kind: Option<String>,
    amount: Option<f64>,
    account: Option<String>,
    to_account: Option<String>,
    category: Option<String>,
    merchant: Option<String>,
    when: Option<String>,
    note: Option<String>,
}

impl Hints {
    /// Whether the phone sent a reading at all. A plain line appended by a
    /// two-action Shortcut carries none, and that is the only case in which
    /// this book does any interpreting of its own.
    fn any(&self) -> bool {
        self.kind.is_some()
            || self.amount.is_some()
            || self.account.is_some()
            || self.to_account.is_some()
            || self.category.is_some()
            || self.merchant.is_some()
            || self.when.is_some()
            || self.note.is_some()
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("null"))
        .map(str::to_string)
}

fn number(v: &Value, key: &str) -> Option<f64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => amount_in(s),
        _ => None,
    }
}

/// Reads one JSON object into a capture. The model's fields are taken from a
/// nested `model` object when there is one and from the top level when there
/// is not, so a Shortcut that pipes the dictionary straight through works as
/// well as one that nests it.
fn from_json(v: &Value, raw: &str) -> Option<Spoken> {
    let said = text(v, "said")
        .or_else(|| text(v, "text"))
        .or_else(|| text(v, "input"))?;
    let model = v.get("model").filter(|m| m.is_object()).unwrap_or(v);
    Some(Spoken {
        said,
        raw: raw.to_string(),
        at: text(v, "at").or_else(|| text(v, "date")),
        source: text(v, "src").unwrap_or_else(|| "siri".into()),
        hints: Hints {
            kind: text(model, "kind"),
            amount: number(model, "amount"),
            account: text(model, "account"),
            to_account: text(model, "toAccount").or_else(|| text(model, "to_account")),
            category: text(model, "category"),
            merchant: text(model, "merchant"),
            when: text(model, "when"),
            note: text(model, "note"),
        },
    })
}

/// Splits the drop into captures.
///
/// Shortcuts appends exactly the text it is given, so whether the lines are
/// separated at all depends on a trailing newline nobody can see in the
/// editor. Rather than make that the difference between working and silently
/// losing every capture but the first, the file is read by brace depth:
/// balanced objects are taken wherever they fall, and anything left over
/// between them is treated as a bare dictated line.
fn split_captures(raw: &str) -> Vec<Spoken> {
    let mut out = Vec::new();
    let mut loose = String::new();
    let mut buf = String::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    let flush_loose = |loose: &mut String, out: &mut Vec<Spoken>| {
        for line in loose.lines() {
            let line = line.trim();
            if !line.is_empty() {
                out.push(Spoken {
                    said: line.to_string(),
                    raw: line.to_string(),
                    source: "text".into(),
                    ..Default::default()
                });
            }
        }
        loose.clear();
    };

    for ch in raw.chars() {
        if depth == 0 {
            if ch == '{' {
                flush_loose(&mut loose, &mut out);
                depth = 1;
                buf.push(ch);
            } else {
                loose.push(ch);
            }
            continue;
        }
        buf.push(ch);
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    let parsed = serde_json::from_str::<Value>(&buf)
                        .ok()
                        .as_ref()
                        .and_then(|v| from_json(v, &buf));
                    match parsed {
                        Some(spoken) => out.push(spoken),
                        // Not JSON after all — most likely a dictated quote
                        // mark inside the sentence. It arrives ugly and gets
                        // fixed in the Inbox, which is a great deal better
                        // than a capture that disappears without a word.
                        None => out.push(Spoken {
                            said: buf.trim().to_string(),
                            raw: buf.trim().to_string(),
                            source: "text".into(),
                            ..Default::default()
                        }),
                    }
                    buf.clear();
                }
            }
            _ => {}
        }
    }
    flush_loose(&mut loose, &mut out);
    out
}

/* -------------------------------------------------------------- the words */

/// Everything after this point works on a lowercased sentence padded with
/// spaces, so a word can be looked for with its boundaries attached and
/// "cash" never matches inside "cashew".
fn padded(said: &str) -> String {
    let mut s = String::from(" ");
    s.push_str(&said.to_lowercase());
    s.push(' ');
    // Punctuation is a word boundary, not a character anybody dictated.
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == ',' || c == '@' { c } else { ' ' })
        .collect()
}

/// The first figure in a sentence, in rupees.
///
/// Ordinals are skipped — "on the 5th" is a date, not five rupees — and a
/// trailing k multiplies, because "one point two k" comes back from dictation
/// as "1.2k" often enough to be worth understanding.
fn amount_in(said: &str) -> Option<f64> {
    let lower = said.to_lowercase();
    let bytes: Vec<char> = lower.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut digits = String::new();
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == ',' || bytes[i] == '.') {
            if bytes[i] != ',' {
                digits.push(bytes[i]);
            }
            i += 1;
        }
        // A number written as an ordinal is a day of the month.
        let suffix: String = bytes[i..].iter().take(2).collect();
        if matches!(suffix.as_str(), "st" | "nd" | "rd" | "th") {
            continue;
        }
        let scale = if bytes.get(i) == Some(&'k') { 1000.0 } else { 1.0 };
        // A bare year-looking number nobody put a currency mark on is a date.
        let value: f64 = digits.trim_end_matches('.').parse().ok()?;
        let marked = lower[..start.min(lower.len())]
            .trim_end()
            .ends_with(['\u{20B9}', '$'])
            || start >= 3 && lower[..start].trim_end().to_lowercase().ends_with("rs");
        if !marked && scale == 1.0 && (1900.0..=2100.0).contains(&value) && value.fract() == 0.0 {
            continue;
        }
        return Some(value * scale);
    }
    None
}

/// Which way the money went. Expense is the default because most sentences
/// are one, and because a wrong guess here is visible on the row rather than
/// hidden inside it.
fn kind_in(said: &str) -> String {
    let s = padded(said);
    const TRANSFERS: [&str; 7] = [
        " transfer ", " transferred ", " moved ", " move ", " paid off ", " topped up ", " top up ",
    ];
    const INCOMES: [&str; 9] = [
        " got ", " received ", " earned ", " refunded ", " refund ", " salary ", " credited ",
        " came in ", " paid me ",
    ];
    if TRANSFERS.iter().any(|w| s.contains(w)) {
        return "transfer".into();
    }
    if INCOMES.iter().any(|w| s.contains(w)) {
        return "income".into();
    }
    "expense".into()
}

/// Words that can only mean the money came out of what follows them.
const STRONG_FROM: [&str; 5] = ["from", "using", "with", "via", "through"];
/// Words that mean it went *into* what follows: the far end of a move, and
/// the card in "paid off Swiggy".
const TO_WORDS: [&str; 4] = ["to", "into", "onto", "off"];
/// Words that could mean either. "on" is the whole problem: "on the HDFC
/// card" is an account and "on Swiggy" is a shop, and this book has accounts
/// named after both a food delivery service and a coffee chain.
const WEAK_FROM: [&str; 2] = ["on", "in"];
/// What a person says between the preposition and the name when they mean an
/// account of theirs, and almost never when they mean a shop.
const DETERMINERS: [&str; 4] = ["my", "the", "our", "your"];
/// A noun after the name that settles it the other way: "on Swiggy card".
const ACCOUNT_NOUNS: [&str; 4] = ["card", "account", "wallet", "credit"];

/// Finds an account by name in the sentence, returning which side of a move
/// it sat on.
///
/// The rule this is built around: a name is only an account when the sentence
/// marks it as the way the money travelled. A bare mention is the shop, and
/// leaving it unclaimed costs a trip through the Inbox — where claiming it
/// wrongly would quietly move somebody else's balance.
///
/// Destinations are read only out of transfers. "Paid 500 to Ravi" names a
/// person, and the only reason "to Federal" is different is that a transfer
/// is a sentence about two accounts by definition.
fn accounts_in(
    conn: &Connection,
    said: &str,
    kind: &str,
) -> Result<(Option<String>, Option<String>)> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM accounts WHERE archived = 0 ORDER BY LENGTH(name) DESC")
        .map_err(oops)?;
    let accounts: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let s = padded(said);
    let mut from = None;
    let mut to = None;
    for (id, name) in &accounts {
        let needle = format!(" {} ", name.to_lowercase());
        let Some(at) = s.find(&needle) else { continue };
        let before: Vec<&str> = s[..at].split_whitespace().rev().collect();
        // The word in front, looking past "my" and "the" to the preposition
        // they belong to: "from my HDFC" marks the same thing "from HDFC" does.
        let determined = before.first().is_some_and(|w| DETERMINERS.contains(w));
        let marker = if determined { before.get(1) } else { before.first() };
        let Some(marker) = marker.copied() else { continue };
        // And the word after, which is the other way a name can be settled.
        let after = s[at + needle.len() - 1..]
            .split_whitespace()
            .next()
            .unwrap_or("");

        if TO_WORDS.contains(&marker) {
            // Money coming in has only one account, and "to" is where it
            // landed: "salary credited to HDFC" names the posting's account,
            // not the far end of a move it is not.
            if kind == "income" {
                from.get_or_insert_with(|| id.clone());
            } else if kind == "transfer" || ACCOUNT_NOUNS.contains(&after) {
                // Only a move has a far end. Anywhere else, "to" is a payee.
                to.get_or_insert_with(|| id.clone());
            }
        } else if STRONG_FROM.contains(&marker)
            || (WEAK_FROM.contains(&marker) && (determined || ACCOUNT_NOUNS.contains(&after)))
        {
            from.get_or_insert_with(|| id.clone());
        }
    }
    Ok((from, to))
}

/// Matches a name the model offered against the accounts that exist. Exact
/// first, then a name that contains it — "HDFC card" is the HDFC account,
/// and dictation adds words like that constantly.
fn account_named(conn: &Connection, name: &str) -> Result<Option<String>> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare("SELECT id, name FROM accounts WHERE archived = 0")
        .map_err(oops)?;
    let accounts: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    if let Some((id, _)) = accounts.iter().find(|(_, n)| n.to_lowercase() == name) {
        return Ok(Some(id.clone()));
    }
    let near: Vec<&(String, String)> = accounts
        .iter()
        .filter(|(_, n)| {
            let n = n.to_lowercase();
            name.contains(&n) || n.contains(&name)
        })
        .collect();
    // One near miss is a match; two is a coin toss, and a coin toss belongs
    // in the Inbox rather than in the ledger.
    Ok(near.first().filter(|_| near.len() == 1).map(|(id, _)| id.clone()))
}

/// What a posting can actually be filed under: every sub-category, plus any
/// top-level category nobody has given children to. Groups with children are
/// headings — the ledger refuses them, so neither the model nor the resolver
/// is ever offered one.
const FILEABLE: &str = "
    SELECT c.id, p.name, c.name
    FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE (c.parent_id IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id))
";

/// Matches a category the model named. The prompt asks for "Group > Sub", so
/// that is tried whole first; a bare leaf is accepted only when one category
/// wears the name, because this book has four different Gifts and three
/// different Misc, and picking among them by guess helps nobody.
fn category_named(conn: &Connection, name: &str, kind: &str) -> Result<Option<String>> {
    let want = name.trim().to_lowercase();
    if want.is_empty() {
        return Ok(None);
    }
    // Money coming in is filed under a different tree from money going out,
    // and this book keeps a Gifts in both. Asking for the wrong one is not an
    // ambiguity to be resolved — it is a category that does not apply.
    let mut stmt = conn
        .prepare(&format!("{FILEABLE} AND c.kind = ?1"))
        .map_err(oops)?;
    let rows: Vec<(String, Option<String>, String)> = stmt
        .query_map(params![kind], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;

    let full = |g: &Option<String>, l: &str| match g {
        Some(g) => format!("{g} > {l}").to_lowercase(),
        None => l.to_lowercase(),
    };
    if let Some((id, _, _)) = rows.iter().find(|(_, g, l)| full(g, l) == want) {
        return Ok(Some(id.clone()));
    }
    // "Food & Drink Coffee", "food and drink > coffee" — the same thing said
    // with the punctuation dictation happened to hear.
    let loose = |s: &str| {
        s.to_lowercase()
            .replace('&', " and ")
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let want_loose = loose(&want);
    if let Some((id, _, _)) = rows
        .iter()
        .find(|(_, g, l)| loose(&full(g, l)) == want_loose)
    {
        return Ok(Some(id.clone()));
    }
    let leaf = want.rsplit('>').next().unwrap_or(&want).trim().to_string();
    let hits: Vec<&(String, Option<String>, String)> = rows
        .iter()
        .filter(|(_, _, l)| l.to_lowercase() == leaf)
        .collect();
    Ok(hits.first().filter(|_| hits.len() == 1).map(|(id, _, _)| id.clone()))
}

/// A category this book keeps, named in the sentence out loud: "for coffee",
/// "on fuel". Only taken when exactly one category wears the word — and only
/// as a last resort, after history and after the model's own reading.
fn category_said(conn: &Connection, said: &str, kind: &str) -> Result<Option<String>> {
    let s = padded(said);
    let mut stmt = conn
        .prepare(&format!("{FILEABLE} AND c.kind = ?1"))
        .map_err(oops)?;
    let hits: Vec<(String, String)> = stmt
        .query_map(params![kind], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(2)?))
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?
        .into_iter()
        .filter(|(_, name)| s.contains(&format!(" {} ", name.to_lowercase())))
        .collect();
    Ok(hits.first().filter(|_| hits.len() == 1).map(|(id, _)| id.clone()))
}

/// How this counterparty was filed last time. The better signal by far: it
/// comes from postings this book actually holds rather than from a model's
/// reading of one sentence, and it costs one indexed lookup.
fn category_by_history(conn: &Connection, merchant: &str, kind: &str) -> Result<Option<String>> {
    let merchant = merchant.trim().to_lowercase();
    if merchant.is_empty() {
        return Ok(None);
    }
    // Filed the same way *and* in the same direction. One refund received
    // from a shop you buy dinner at would otherwise file every dinner under
    // Rewards for the rest of the book's life.
    let by_posting = conn
        .query_row(
            "SELECT category_id FROM transactions
             WHERE LOWER(merchant) = ?1 AND kind = ?2 AND category_id IS NOT NULL
             ORDER BY occurred_at DESC LIMIT 1",
            params![merchant, kind],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(oops)?
        .flatten();
    if by_posting.is_some() {
        return Ok(by_posting);
    }
    // Failing that, what the statement importer was taught about the name.
    conn.query_row(
        "SELECT category_id FROM import_rules
         WHERE LOWER(merchant) = ?1 AND kind = ?2 AND category_id IS NOT NULL
         ORDER BY confirmed DESC, updated_at DESC LIMIT 1",
        params![merchant, kind],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(oops)
    .map(|o| o.flatten())
}

/// Who the money was with: the words after "at", "on", "to" or "for",
/// stopping at the next preposition — "at Blue Tokai on the HDFC card" says
/// the shop and the account in one breath, and the shop ends where the
/// account begins.
///
/// Names already claimed as accounts stop it too, which is what keeps the
/// account out of the merchant column when the sentence only named one thing.
fn merchant_in(said: &str, account_words: &[String]) -> String {
    let lower = said.to_lowercase();
    // In order of how strongly each one means "and here is who": "at Blue
    // Tokai" is a payee beyond argument, "for coffee" is usually what it was
    // rather than who it was with. The strongest one present wins, so
    // "320 for coffee at Starbucks" is Starbucks and not Coffee.
    const STARTS: [&str; 4] = ["at", "to", "on", "for"];
    const STOPS: [&str; 13] = [
        "at", "on", "for", "to", "from", "using", "with", "via", "through", "off", "into",
        "yesterday", "today",
    ];
    const SKIP: [&str; 6] = ["the", "my", "a", "an", "card", "account"];
    let words: Vec<String> = lower
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect::<String>())
        .filter(|w| !w.is_empty())
        .collect();

    for start in STARTS {
        let Some(at) = words.iter().position(|w| w == start) else { continue };
        let mut taken: Vec<String> = Vec::new();
        for word in &words[at + 1..] {
            if STOPS.contains(&word.as_str()) || account_words.contains(word) {
                break;
            }
            // A figure is the amount, never the payee.
            if SKIP.contains(&word.as_str()) || word.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            taken.push(word.clone());
        }
        if !taken.is_empty() {
            return title_case(&taken.join(" "));
        }
    }
    String::new()
}

/// A note goes in capitalised and otherwise exactly as it arrived. Trimming
/// the words in front of it is the model's job — it has the whole sentence to
/// judge by, where this would only have a list of prepositions and no idea
/// whether one of them was meant.
fn capitalised(note: &str) -> Option<String> {
    let mut chars = note.trim().chars();
    let first = chars.next()?;
    Some(first.to_uppercase().collect::<String>() + chars.as_str())
}

/// How many single-character edits turn one string into the other. Bounded
/// by the shorter string, and only ever run on names, so the quadratic cost
/// is a few hundred cells.
fn edits(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            let next = (row[j + 1] + 1).min(row[j] + 1).min(prev + cost);
            prev = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// Settles a counterparty against the ones this book already holds.
///
/// A name arrives however it was heard — "blue tokai", "Blue Tokai Cafe",
/// "Rapido." — and each spelling of it would otherwise be a counterparty of
/// its own, splitting the history that everything else here depends on. So a
/// name close enough to one already in the ledger becomes that one, exactly
/// as it is already written.
///
/// Close enough means: the same once punctuation and case are set aside; or
/// one contains the other and the shorter is substantial; or within a
/// quarter of its own length in edits. Anything further off is a new
/// counterparty and is kept exactly as it was sent.
fn merchant_named(conn: &Connection, said: &str) -> Result<String> {
    let want = said.trim();
    if want.is_empty() {
        return Ok(String::new());
    }
    let plain = |s: &str| -> String { s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect() };
    let target = plain(want);
    if target.is_empty() {
        return Ok(title_case(want));
    }

    let known = known_merchants(conn, None)?;
    let mut best: Option<(usize, String)> = None;
    for name in known {
        let other = plain(&name);
        if other.is_empty() {
            continue;
        }
        if other == target {
            // Already a name in the book, however it was spelled out loud.
            return Ok(name);
        }
        let shortest = other.chars().count().min(target.chars().count());
        let distance = if shortest >= 4 && (other.contains(&target) || target.contains(&other)) {
            1
        } else {
            edits(&other, &target)
        };
        let allowed = (other.chars().count().max(target.chars().count()) / 4).max(1);
        if distance <= allowed && best.as_ref().is_none_or(|(d, _)| distance < *d) {
            best = Some((distance, name));
        }
    }
    // Nothing near enough: it is somebody new, in the words they arrived in.
    Ok(best.map(|(_, name)| name).unwrap_or_else(|| title_case(want)))
}

fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/* --------------------------------------------------------------- the date */

/// When the line was said, read from the timestamp the Shortcut wrote beside
/// it — or nothing, when it wrote none or wrote it in a shape nobody here
/// recognises.
///
/// Shortcuts' "Format Date" is a picker, and the picker has more than one
/// right answer: ISO 8601 with the time on carries a zone, without it does
/// not, and a custom pattern can leave out the `T` or the seconds. Every
/// one of those is the same moment, so all of them are read. A wall-clock
/// time without a zone is taken to be the phone's own, which is the only
/// clock a person dictating to it was looking at.
///
/// What is *not* done is fall back to now: a capture whose time cannot be
/// read is better filed at the moment it was read than at a guess dressed
/// as a fact — but that fallback belongs to the caller, which knows which
/// "now" it means.
fn spoken_at(at: &str) -> Option<NaiveDateTime> {
    let at = at.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(at) {
        return Some(dt.with_timezone(&Local).naive_local());
    }
    const SHAPES: [&str; 6] = [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ];
    for shape in SHAPES {
        if let Ok(dt) = NaiveDateTime::parse_from_str(at, shape) {
            return Some(dt);
        }
    }
    // A bare day, with no hour to keep. Noon, as elsewhere: the middle of
    // the day it names, and on nobody's boundary.
    NaiveDate::parse_from_str(at, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(12, 0, 0))
}

fn weekday(word: &str) -> Option<Weekday> {
    Some(match word {
        "monday" => Weekday::Mon,
        "tuesday" => Weekday::Tue,
        "wednesday" => Weekday::Wed,
        "thursday" => Weekday::Thu,
        "friday" => Weekday::Fri,
        "saturday" => Weekday::Sat,
        "sunday" => Weekday::Sun,
        _ => return None,
    })
}

/// Turns a time phrase into a day, counted back from when the sentence was
/// said rather than from now — a capture that sat in iCloud overnight still
/// means the day it was spoken about.
///
/// Arithmetic is done here rather than asked of the model on purpose: a small
/// model will happily return a Tuesday that was not one.
fn day_from(phrase: Option<&str>, spoken_on: NaiveDate) -> NaiveDate {
    let Some(phrase) = phrase.map(str::to_lowercase) else {
        return spoken_on;
    };
    let words: Vec<String> = phrase
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    if words.iter().any(|w| w == "yesterday") {
        return spoken_on - Duration::days(1);
    }
    if words.iter().any(|w| w == "today" || w == "now") {
        return spoken_on;
    }
    // "three days ago", "2 days back"
    if let Some(pos) = words.iter().position(|w| w == "days" || w == "day") {
        if pos > 0 {
            if let Ok(n) = words[pos - 1].parse::<i64>() {
                return spoken_on - Duration::days(n.clamp(0, 365));
            }
        }
    }
    // A weekday names the most recent one that has already happened.
    if let Some(target) = words.iter().find_map(|w| weekday(w)) {
        let mut day = spoken_on - Duration::days(1);
        for _ in 0..7 {
            if day.weekday() == target {
                return day;
            }
            day -= Duration::days(1);
        }
    }
    spoken_on
}

/* ----------------------------------------------------------- the resolving */

/// A capture as the book understands it, before anybody has looked.
struct Resolved {
    kind: String,
    amount: Paise,
    account_id: Option<String>,
    to_account_id: Option<String>,
    category_id: Option<String>,
    merchant: String,
    occurred_at: String,
    note: Option<String>,
    /// What could not be worked out, in the words the Inbox shows.
    unresolved: Vec<String>,
}

impl Resolved {
    /// Whether this can go into the ledger unaided: nothing about it left
    /// open. An uncategorised posting is not wrong, but it is unfinished —
    /// and one that lands in the ledger unfinished is one nobody comes back
    /// to, because nothing is asking them to. Better it waits where it is
    /// visibly waiting.
    fn complete(&self) -> bool {
        self.unresolved.is_empty()
    }
}

fn resolve(conn: &Connection, spoken: &Spoken) -> Result<Resolved> {
    let said = &spoken.said;
    // A line that does not say when it was said is taken to have been said
    // now — which is when it was *read*, and only the same thing while the
    // Shortcut and this book are on speaking terms. A Shortcut that writes
    // `at` beside the sentence is the fix; this is the fallback.
    let spoken_at = spoken
        .at
        .as_deref()
        .and_then(spoken_at)
        .unwrap_or_else(|| Local::now().naive_local());

    // Whether to interpret at all.
    //
    // When the phone sent a reading, that reading *is* the answer: nothing
    // here second-guesses it, fills a field it left empty, or overrules it
    // with what this book has seen before. The model has the whole sentence
    // and this book's own book file in front of it; the rules below have a
    // list of prepositions. Where they disagree the model was right often
    // enough that being clever cost more than it earned.
    //
    // A line with no reading — a plain sentence appended by a two-action
    // Shortcut — gets the full treatment, because there is nothing else.
    let read_by_model = spoken.hints.any();

    // Case-folded before it is judged: a picker offers "Expense" because
    // that is what reads well on a phone, and the ledger's word for the same
    // thing is lower case.
    let kind = spoken
        .hints
        .kind
        .as_deref()
        .map(|k| k.trim().to_lowercase())
        .filter(|k| matches!(k.as_str(), "income" | "expense" | "transfer"))
        .unwrap_or_else(|| kind_in(said));

    let rupees = spoken.hints.amount.or_else(|| amount_in(said)).unwrap_or(0.0);
    // Rupees are what a person says; paise are what the book keeps.
    let amount = (rupees.max(0.0) * 100.0).round() as Paise;

    // Whatever names an account has to name one this book actually holds, so
    // a bank nobody has heard of resolves to nothing rather than to a guess.
    let (said_from, said_to) = if read_by_model {
        (None, None)
    } else {
        accounts_in(conn, said, &kind)?
    };
    let account_id = match spoken.hints.account.as_deref() {
        Some(name) => account_named(conn, name)?,
        None => said_from,
    };
    let to_account_id = if kind == "transfer" {
        match spoken.hints.to_account.as_deref() {
            Some(name) => account_named(conn, name)?,
            None => said_to,
        }
    } else {
        None
    };

    // The words that turned out to be accounts are not also the shop.
    let mut account_words: Vec<String> = Vec::new();
    for id in [account_id.as_deref(), to_account_id.as_deref()].into_iter().flatten() {
        if let Some(name) = conn
            .query_row("SELECT name FROM accounts WHERE id = ?1", params![id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(oops)?
        {
            account_words.extend(name.to_lowercase().split_whitespace().map(str::to_string));
        }
    }
    let heard = spoken
        .hints
        .merchant
        .clone()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| {
            if read_by_model {
                String::new()
            } else {
                merchant_in(said, &account_words)
            }
        });
    // Settled against the counterparties this book already holds, so a name
    // heard slightly differently does not become a second one.
    let merchant = merchant_named(conn, &heard)?;

    // A transfer is money between your own accounts and is never categorised,
    // which is a rule the ledger enforces anyway — better not to offer one.
    let category_id = if kind == "transfer" {
        None
    } else {
        let named = match spoken.hints.category.as_deref() {
            Some(name) => category_named(conn, name, &kind)?,
            None => None,
        };
        match named {
            Some(named) => Some(named),
            // Only where nothing read the sentence: how this book filed the
            // counterparty last time, then a category named in the words.
            None if !read_by_model => match category_by_history(conn, &merchant, &kind)? {
                Some(known) => Some(known),
                None => category_said(conn, said, &kind)?,
            },
            None => None,
        }
    };

    let when = match (spoken.hints.when.as_deref(), read_by_model) {
        (Some(phrase), _) => Some(phrase),
        // Only a line nobody read gets its date dug out of the words.
        (None, false) => Some(said.as_str()),
        (None, true) => None,
    };
    let day = day_from(when, spoken_at.date());
    let occurred_at = if day == spoken_at.date() {
        spoken_at.format("%Y-%m-%dT%H:%M").to_string()
    } else {
        // A day recalled rather than lived through has no hour worth keeping.
        NaiveDateTime::from(day).format("%Y-%m-%dT12:00").to_string()
    };

    let mut unresolved = Vec::new();
    if amount <= 0 {
        unresolved.push("amount".into());
    }
    if account_id.is_none() {
        unresolved.push("account".into());
    }
    if kind == "transfer" && to_account_id.is_none() {
        unresolved.push("destination".into());
    }
    if category_id.is_none() && kind != "transfer" {
        unresolved.push("category".into());
    }

    Ok(Resolved {
        kind,
        amount,
        account_id,
        to_account_id,
        category_id,
        merchant,
        occurred_at,
        note: spoken.hints.note.as_deref().and_then(capitalised),
        unresolved,
    })
}

/* --------------------------------------------------------------- the sync */

/// Reads whatever the phone has left and files it.
///
/// The whole file is read every time rather than picked up from a saved
/// offset. It holds a handful of lines a day, iCloud can replace it under us
/// at any moment, and a duplicate is refused by the digest anyway — so
/// re-reading costs nothing and cannot get out of step with the file.
pub fn sync(conn: &Connection) -> Result<CaptureSync> {
    let path = inbox_path(conn);
    let mut result = CaptureSync {
        found: 0,
        posted: 0,
        pending: 0,
        inbox: path.to_string_lossy().into_owned(),
        book: book_text_path(conn).to_string_lossy().into_owned(),
    };
    // Keeping the book file current is part of the round trip: the file the
    // phone reads is only as good as the last time somebody looked.
    let _ = write_book(conn);

    for file in inbox_files(conn) {
        let raw = match std::fs::read_to_string(&file) {
            Ok(raw) => raw,
            // No drop yet is the ordinary state of a book nobody has
            // dictated to.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("The capture inbox could not be read: {e}")),
        };
        let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
        read_into(conn, &raw, &name, &mut result)?;
    }
    Ok(result)
}

/// Files one drop file's worth of captures, counting what it did into
/// `result`. Split out so the several files a drop can be spread across all
/// go through one door.
fn read_into(conn: &Connection, raw: &str, file: &str, result: &mut CaptureSync) -> Result<()> {
    for (ordinal, spoken) in split_captures(raw).into_iter().enumerate() {
        // What makes this line this line, and not one already read.
        //
        // A line carrying its own timestamp is identified by that and its
        // words, which holds however the file is later edited. A bare line —
        // a Shortcut that appends the sentence and nothing else — has no such
        // mark, so its place in the file stands in: without it, saying "coffee
        // 100 from wallet" twice in a week would file it once.
        // A line carrying a timestamp is that line wherever it is written,
        // so the file it came in is deliberately left out: iCloud renaming
        // the drop must not re-file everything in it. A bare line has only
        // its place to be known by, and places repeat between files.
        let digest = match spoken.at.as_deref() {
            Some(at) => format!("{}|{}", at, spoken.said.trim()),
            None => format!("{}#{}|{}", file, ordinal, spoken.said.trim()),
        };
        let already: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM captures WHERE digest = ?1",
                params![digest],
                |r| r.get(0),
            )
            .map_err(oops)?;
        if already > 0 {
            continue;
        }
        result.found += 1;

        let r = resolve(conn, &spoken)?;
        let id = new_id();
        // Kept in one shape however the Shortcut wrote it, so the Inbox
        // sorts by when things were said rather than by how they were spelt.
        let captured_at = spoken
            .at
            .as_deref()
            .and_then(spoken_at)
            .and_then(|dt| dt.and_local_timezone(Local).single())
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(now);
        conn.execute(
            "INSERT INTO captures
                (id, digest, said, raw, source, captured_at, ingested_at, kind, amount,
                 account_id, to_account_id, category_id, merchant, occurred_at, note,
                 status, unresolved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                     'pending', ?16)",
            params![
                id,
                digest,
                spoken.said.trim(),
                spoken.raw.trim(),
                spoken.source,
                captured_at,
                now(),
                r.kind,
                r.amount,
                r.account_id,
                r.to_account_id,
                r.category_id,
                r.merchant,
                r.occurred_at,
                r.note,
                r.unresolved.join(","),
            ],
        )
        .map_err(oops)?;

        // Certain enough to be money: it goes in, wearing the label that says
        // where it came from.
        if r.complete() {
            match post(conn, &id, input_from(&r)) {
                Ok(_) => result.posted += 1,
                // A posting the ledger refuses is not a posting worth losing:
                // it stays pending, with the reason where a person can read it.
                Err(why) => {
                    conn.execute(
                        "UPDATE captures SET unresolved = ?2 WHERE id = ?1",
                        params![id, why],
                    )
                    .map_err(oops)?;
                    result.pending += 1;
                }
            }
        } else {
            result.pending += 1;
        }
    }
    Ok(())
}

fn input_from(r: &Resolved) -> TransactionInput {
    TransactionInput {
        id: None,
        kind: r.kind.clone(),
        amount: r.amount,
        account_id: r.account_id.clone().unwrap_or_default(),
        to_account_id: r.to_account_id.clone(),
        category_id: r.category_id.clone(),
        merchant: r.merchant.clone(),
        note: r.note.clone(),
        occurred_at: r.occurred_at.clone(),
        splits: None,
        shares: None,
        label_ids: None,
        refund_of: None,
        cashback: None,
    }
}

/// Writes one capture into the ledger and closes it out. The posting goes
/// through the same door a hand-written one does, and wears the Siri label —
/// which is a fact about the posting rather than a queue, so nothing ever
/// takes it off again.
pub fn post(conn: &Connection, id: &str, input: TransactionInput) -> Result<Transaction> {
    let tx = db::save_transaction(conn, input)?;
    db::pin_siri(conn, &tx.id)?;
    conn.execute(
        "UPDATE captures SET status = 'posted', transaction_id = ?2, unresolved = ''
         WHERE id = ?1",
        params![id, tx.id],
    )
    .map_err(oops)?;
    Ok(tx)
}

/// Takes a capture off the pile without writing anything. Misheard, said
/// twice, or simply not worth recording.
pub fn dismiss(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE captures SET status = 'dismissed' WHERE id = ?1",
        params![id],
    )
    .map_err(oops)?;
    Ok(())
}

/// Captures in one state, newest first.
///
/// A posted capture reads its figures off the posting it became rather than
/// off what was heard at the time: correct the transaction and this follows,
/// instead of the history quietly disagreeing with the ledger. Where there is
/// no posting — anything still waiting — the capture answers for itself.
pub fn list(conn: &Connection, status: &str) -> Result<Vec<Capture>> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.said, c.raw, c.source, c.captured_at, c.status, c.transaction_id,
                    COALESCE(t.kind, c.kind),
                    COALESCE(t.amount, c.amount),
                    COALESCE(t.account_id, c.account_id),
                    COALESCE(ta.name, ca.name),
                    COALESCE(t.to_account_id, c.to_account_id),
                    COALESCE(tta.name, cta.name),
                    COALESCE(t.category_id, c.category_id),
                    COALESCE(tcat.name, ccat.name),
                    COALESCE(tcat.icon, ccat.icon),
                    COALESCE(tcat.color, ccat.color),
                    COALESCE(tp.name, cp.name),
                    COALESCE(t.merchant, c.merchant),
                    COALESCE(t.occurred_at, c.occurred_at),
                    COALESCE(t.note, c.note),
                    c.unresolved
             FROM captures c
             LEFT JOIN transactions t   ON t.id = c.transaction_id
             LEFT JOIN accounts ta      ON ta.id = t.account_id
             LEFT JOIN accounts ca      ON ca.id = c.account_id
             LEFT JOIN accounts tta     ON tta.id = t.to_account_id
             LEFT JOIN accounts cta     ON cta.id = c.to_account_id
             LEFT JOIN categories tcat  ON tcat.id = t.category_id
             LEFT JOIN categories ccat  ON ccat.id = c.category_id
             LEFT JOIN categories tp    ON tp.id = tcat.parent_id
             LEFT JOIN categories cp    ON cp.id = ccat.parent_id
             WHERE c.status = ?1
             ORDER BY c.captured_at DESC",
        )
        .map_err(oops)?;
    let rows = stmt
        .query_map(params![status], |r| {
            let unresolved: String = r.get(21)?;
            Ok(Capture {
                id: r.get(0)?,
                said: r.get(1)?,
                raw: r.get(2)?,
                source: r.get(3)?,
                captured_at: r.get(4)?,
                status: r.get(5)?,
                transaction_id: r.get(6)?,
                kind: r.get(7)?,
                amount: r.get(8)?,
                account_id: r.get(9)?,
                account_name: r.get(10)?,
                to_account_id: r.get(11)?,
                to_account_name: r.get(12)?,
                category_id: r.get(13)?,
                category_name: r.get(14)?,
                category_icon: r.get(15)?,
                category_color: r.get(16)?,
                category_group_name: r.get(17)?,
                merchant: r.get(18)?,
                occurred_at: r.get(19)?,
                note: r.get(20)?,
                unresolved: unresolved
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        })
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

/// What is still waiting for a person — the Siri screen's first tab.
pub fn pending(conn: &Connection) -> Result<Vec<Capture>> {
    list(conn, "pending")
}

/// Everything that made it into the ledger, said-first — the history.
pub fn history(conn: &Connection) -> Result<Vec<Capture>> {
    list(conn, "posted")
}



// ----------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// A book with the accounts that make the hard cases hard: Swiggy is a
    /// credit line *and* a place you buy dinner, Starbucks is a wallet *and*
    /// a coffee shop. Every rule below exists because of names like these.
    fn book() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db::migrate(&conn).unwrap();
        for (name, kind) in [
            ("HDFC", "bank"),
            ("Federal", "bank"),
            ("Swiggy", "credit"),
            ("Wallet", "cash"),
        ] {
            db::save_account(
                &conn,
                AccountInput {
                    id: None,
                    name: name.into(),
                    kind: kind.into(),
                    institution: None,
                    opening_balance: 100_000_00,
                    color: "#000000".into(),
                    icon: "wallet".into(),
                },
            )
            .unwrap();
        }
        // A book seeds a flat list of categories; this one is deepened the
        // way a used book ends up, so both shapes are under test — and so
        // that two different groups end up with a Gifts of their own.
        child(&conn, "Food & Drink", "Coffee");
        child(&conn, "Shopping", "Gifts");
        child(&conn, "Travel", "Gifts");
        conn
    }

    /// Files a sub-category under a seeded group, returning its id. Calling
    /// it twice for the same name hands back the one already there.
    fn child(conn: &Connection, group: &str, name: &str) -> String {
        let parent: String = conn
            .query_row(
                "SELECT id FROM categories WHERE name = ?1 AND parent_id IS NULL",
                params![group],
                |r| r.get(0),
            )
            .unwrap();
        if let Some(id) = conn
            .query_row(
                "SELECT id FROM categories WHERE name = ?1 AND parent_id = ?2",
                params![name, parent],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .unwrap()
        {
            return id;
        }
        db::save_category(
            conn,
            CategoryInput {
                id: None,
                kind: "expense".into(),
                name: name.into(),
                icon: "coffee".into(),
                color: "#F2724F".into(),
                parent_id: Some(parent),
            },
        )
        .unwrap()
        .id
    }

    fn said(text: &str) -> Spoken {
        Spoken {
            said: text.into(),
            raw: text.into(),
            at: Some("2026-09-01T19:30:00+05:30".into()),
            source: "siri".into(),
            hints: Hints::default(),
        }
    }

    fn account_id(conn: &Connection, name: &str) -> String {
        conn.query_row(
            "SELECT id FROM accounts WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn reads_the_figure_out_of_a_sentence() {
        assert_eq!(amount_in("spent 450 at blue tokai"), Some(450.0));
        assert_eq!(amount_in("paid rs 1,200 for groceries"), Some(1200.0));
        assert_eq!(amount_in("1.2k on fuel"), Some(1200.0));
        assert_eq!(amount_in("spent 99.50 on coffee"), Some(99.5));
        assert_eq!(amount_in("bought lunch"), None);
    }

    /// A day of the month is not a price. Dictation writes ordinals out, and
    /// "rent on the 5th" was becoming a five rupee posting.
    #[test]
    fn an_ordinal_is_a_date_not_a_figure() {
        assert_eq!(amount_in("paid the rent on the 5th, 25000"), Some(25000.0));
    }

    #[test]
    fn reads_which_way_the_money_went() {
        assert_eq!(kind_in("spent 450 at blue tokai"), "expense");
        assert_eq!(kind_in("got 5000 from ravi"), "income");
        assert_eq!(kind_in("moved 5000 from federal to hdfc"), "transfer");
    }

    /// The whole account/merchant problem in two sentences: the same word,
    /// once as a shop and once as the card it was paid off.
    #[test]
    fn a_bare_name_is_a_shop_not_an_account() {
        let conn = book();
        let (from, to) = accounts_in(&conn, "spent 300 on swiggy", "expense").unwrap();
        assert_eq!(from, None, "a shop must not claim an account");
        assert_eq!(to, None);

        let (from, to) = accounts_in(&conn, "paid off swiggy from hdfc", "transfer").unwrap();
        assert_eq!(from, Some(account_id(&conn, "HDFC")));
        assert_eq!(to, Some(account_id(&conn, "Swiggy")));
    }

    /// What tips "on" the other way: a determiner in front, or the noun a
    /// person says after an account and never after a shop.
    #[test]
    fn a_marked_name_is_an_account() {
        let conn = book();
        let (from, _) = accounts_in(&conn, "spent 450 at blue tokai on the hdfc card", "expense")
            .unwrap();
        assert_eq!(from, Some(account_id(&conn, "HDFC")));

        let (from, _) = accounts_in(&conn, "spent 300 on swiggy card", "expense").unwrap();
        assert_eq!(from, Some(account_id(&conn, "Swiggy")));

        let (from, _) = accounts_in(&conn, "paid 900 using federal", "expense").unwrap();
        assert_eq!(from, Some(account_id(&conn, "Federal")));
    }

    /// "To" names a destination only in a sentence about moving money. In an
    /// expense it is a payee, and Ravi is not an account.
    #[test]
    fn a_destination_is_only_read_out_of_a_move() {
        let conn = book();
        let (_, to) = accounts_in(&conn, "paid 500 to federal", "expense").unwrap();
        assert_eq!(to, None);
        let (_, to) = accounts_in(&conn, "moved 500 to federal", "transfer").unwrap();
        assert_eq!(to, Some(account_id(&conn, "Federal")));
    }

    /// Money coming in has one account, and "to" is where it landed.
    #[test]
    fn income_lands_in_the_account_it_was_paid_to() {
        let conn = book();
        let r = resolve(&conn, &said("got 45000 salary credited to HDFC")).unwrap();
        assert_eq!(r.kind, "income");
        assert_eq!(r.account_id, Some(account_id(&conn, "HDFC")));
        assert_eq!(r.to_account_id, None);
        assert!(r.complete());
    }

    #[test]
    fn resolves_a_whole_sentence() {
        let conn = book();
        let r = resolve(&conn, &said("spent 450 for coffee at Blue Tokai using the HDFC card")).unwrap();
        assert_eq!(r.kind, "expense");
        assert_eq!(r.amount, 45_000);
        assert_eq!(r.account_id, Some(account_id(&conn, "HDFC")));
        assert_eq!(r.merchant, "Blue Tokai");
        assert_eq!(r.occurred_at, "2026-09-01T19:30");
        assert!(r.complete(), "amount and account are both known");
    }

    /// The shop was named without a preposition marking an account, so the
    /// sentence is short one fact and the Inbox is told which.
    #[test]
    fn an_unmarked_sentence_waits_for_a_person() {
        let conn = book();
        let r = resolve(&conn, &said("spent 300 on Swiggy")).unwrap();
        assert_eq!(r.merchant, "Swiggy");
        assert_eq!(r.amount, 30_000);
        assert!(!r.complete());
        assert!(r.unresolved.contains(&"account".to_string()));
    }

    /// History answers for a counterparty the sentence said nothing about —
    /// which is the whole of the plain-text path, where there is no model.
    #[test]
    fn history_files_a_known_counterparty() {
        let conn = book();
        let coffee = child(&conn, "Food & Drink", "Coffee");
        db::save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 30_000,
                account_id: account_id(&conn, "HDFC"),
                to_account_id: None,
                category_id: Some(coffee.clone()),
                merchant: "Blue Tokai".into(),
                note: None,
                occurred_at: "2026-08-01T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        // Nothing in the sentence names a category, so how this book filed
        // the name last time is the best answer there is.
        let spoken = said("spent 450 for coffee at Blue Tokai using the HDFC card");
        assert_eq!(resolve(&conn, &spoken).unwrap().category_id, Some(coffee));
    }

    /// What the sentence says it was for beats what the counterparty usually
    /// is. One Swiggy bill filed under Work must not file every one after it.
    #[test]
    fn a_named_category_beats_the_counterparty_habit() {
        let conn = book();
        let restaurant = child(&conn, "Food & Drink", "Restaurant");
        let work = child(&conn, "Health", "Work Misc");
        db::save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 20_000,
                account_id: account_id(&conn, "HDFC"),
                to_account_id: None,
                category_id: Some(work),
                merchant: "Swiggy".into(),
                note: None,
                occurred_at: "2026-08-01T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let mut spoken = said("Spent 988 on the Swiggy card for biryani");
        spoken.hints.category = Some("Food & Drink > Restaurant".into());
        spoken.hints.merchant = Some("Swiggy".into());
        assert_eq!(resolve(&conn, &spoken).unwrap().category_id, Some(restaurant));
    }

    /// Who the people are is yours and it changes, so it belongs in the book
    /// and travels out with the rest of the word list.
    #[test]
    fn the_word_list_carries_the_people_you_name() {
        let conn = book();
        // A book that has never been told keeps the section and leaves it bare.
        assert_eq!(book_text(&conn).unwrap().split("---").count(), 4);

        db::set_setting(&conn, PEOPLE_SETTING, "- Sanju — girlfriend. Relationship.").unwrap();
        let people = book_text(&conn).unwrap().split("---").nth(3).unwrap().trim().to_string();
        assert_eq!(people, "- Sanju — girlfriend. Relationship.");
    }

    /// The pickers are built from this, so its shape is a contract: the
    /// accounts, what each direction of money offers, and what sits under
    /// each of those — accounts included, answering with themselves.
    #[test]
    fn the_json_word_list_is_shaped_for_pickers() {
        let conn = book();
        child(&conn, "Food & Drink", "Coffee");
        let text = book_json(&conn).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();

        assert!(v["accounts"].as_array().unwrap().iter().any(|a| a == "HDFC"));
        // Expense and income offer their own headings and no others.
        let expense = v["kinds"]["Expense"].as_array().unwrap();
        assert!(expense.iter().any(|g| g == "Food & Drink"));
        assert!(!expense.iter().any(|g| g == "Salary"));
        // A move offers the accounts instead, having no category to give.
        assert_eq!(v["kinds"]["Transfer"], v["accounts"]);
        // And under a heading are its own filings.
        assert!(v["groups"]["Food & Drink"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "Coffee"));
        // An account answers with itself, so the picker confirms rather than
        // offering nothing at all.
        assert_eq!(v["groups"]["HDFC"], serde_json::json!(["HDFC"]));
    }

    /// The first question is a direction of money or a template, and every
    /// answer to it knows the same things about itself — so the shortcut can
    /// read one entry and be told what to ask for and what not to.
    #[test]
    fn a_template_answers_what_it_was_saved_with() {
        let conn = book();
        let coffee = child(&conn, "Food & Drink", "Coffee");
        db::save_template(
            &conn,
            TxTemplateInput {
                id: None,
                name: "AMB Coffee".into(),
                kind: "expense".into(),
                amount: 14_000,
                account_id: Some(account_id(&conn, "HDFC")),
                to_account_id: None,
                category_id: Some(coffee),
                merchant: "AMB".into(),
                note: Some("Flat white".into()),
                splits: None,
                label_ids: None,
            },
        )
        .unwrap();

        let v: serde_json::Value = serde_json::from_str(&book_json(&conn).unwrap()).unwrap();
        // The first question stays short however many templates there are:
        // three directions of money and a way through to the rest.
        let starts: Vec<&str> = v["starts"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        assert_eq!(starts, vec!["Expense", "Income", "Transfer", "Templates…"]);
        assert_eq!(v["templateNames"], serde_json::json!(["AMB Coffee"]));
        // A direction stands for itself; the way through stands for nothing,
        // so the key becomes whatever the second question answered.
        assert_eq!(v["keys"]["Expense"], "Expense");
        assert_eq!(v["keys"]["Templates…"], "");

        // Saved with everything, so it asks for nothing but the note.
        let t = &v["templates"]["AMB Coffee"];
        assert_eq!(t["kind"], "Expense");
        assert_eq!(t["amount"], "140");
        assert_eq!(t["askAmount"], "no");
        assert_eq!(t["account"], "HDFC");
        assert_eq!(t["group"], "Food & Drink");
        assert_eq!(t["sub"], "Coffee");
        assert_eq!(t["merchant"], "AMB");
        assert_eq!(t["askMerchant"], "no");
        assert_eq!(t["note"], "Flat white");
        assert_eq!(t["askNote"], "no");

        // A plain direction of money knows nothing and asks for all of it.
        let plain = &v["templates"]["Expense"];
        assert_eq!(plain["kind"], "Expense");
        assert_eq!(plain["askAmount"], "yes");
        assert_eq!(plain["askAccount"], "yes");
        assert_eq!(plain["askCategory"], "yes");
    }

    /// A counterparty heard slightly differently is the same counterparty.
    /// Every spelling of a name being its own would split the history that
    /// categories, totals and the ledger's own grouping all read from.
    #[test]
    fn a_merchant_settles_onto_one_this_book_already_holds() {
        let conn = book();
        let spend = |merchant: &str| {
            db::save_transaction(
                &conn,
                TransactionInput {
                    id: None,
                    kind: "expense".into(),
                    amount: 10_000,
                    account_id: account_id(&conn, "HDFC"),
                    to_account_id: None,
                    category_id: None,
                    merchant: merchant.into(),
                    note: None,
                    occurred_at: "2026-08-01T10:00".into(),
                    splits: None,
                    shares: None,
                    label_ids: None,
                    refund_of: None,
                    cashback: None,
                },
            )
            .unwrap();
        };
        spend("Blue Tokai");
        spend("Rapido");

        // Case and punctuation are not a different shop.
        assert_eq!(merchant_named(&conn, "blue tokai").unwrap(), "Blue Tokai");
        assert_eq!(merchant_named(&conn, "Rapido.").unwrap(), "Rapido");
        // Nor is a word the model tacked on.
        assert_eq!(merchant_named(&conn, "Blue Tokai Cafe").unwrap(), "Blue Tokai");
        // Nor a letter misheard.
        assert_eq!(merchant_named(&conn, "Rapidoo").unwrap(), "Rapido");
        // Somebody new arrives as themselves.
        assert_eq!(merchant_named(&conn, "third wave").unwrap(), "Third Wave");
        assert_eq!(merchant_named(&conn, "").unwrap(), "");
    }

    /// A transfer's merchant is bookkeeping, not a counterparty — offering
    /// it as a name to match against would file coffees against it.
    #[test]
    fn transfers_are_not_counterparties() {
        let conn = book();
        db::save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "transfer".into(),
                amount: 10_000,
                account_id: account_id(&conn, "HDFC"),
                to_account_id: Some(account_id(&conn, "Federal")),
                category_id: None,
                merchant: "Transfer".into(),
                note: None,
                occurred_at: "2026-08-01T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();
        assert!(known_merchants(&conn, None).unwrap().is_empty());
        assert_eq!(merchant_named(&conn, "Transfr").unwrap(), "Transfr");
    }

    /// A picker says "Expense" because that is what reads well on a phone.
    /// The ledger's word for it is lower case, and the two must not be a
    /// difference that turns income into spending.
    #[test]
    fn the_direction_is_read_however_it_is_capitalised() {
        let conn = book();
        let mut spoken = said("Income: 45000 at Work using HDFC");
        spoken.hints.amount = Some(45_000.0);
        spoken.hints.account = Some("HDFC".into());
        spoken.hints.kind = Some("Income".into());
        assert_eq!(resolve(&conn, &spoken).unwrap().kind, "income");

        // And something that is not a direction at all falls back to the verb.
        spoken.hints.kind = Some("Whatever".into());
        assert_eq!(resolve(&conn, &spoken).unwrap().kind, "expense");
    }

    /// A shortcut built from a file cannot branch, so the manual one sends a
    /// category *and* a destination every time and lets the ledger's own
    /// rules drop whichever does not apply. Both directions are checked here,
    /// because this only works while those rules hold.
    #[test]
    fn a_capture_may_carry_both_a_category_and_a_destination() {
        let conn = book();
        let coffee = child(&conn, "Food & Drink", "Coffee");

        // An expense: the destination names no account of yours, and a
        // non-transfer has nowhere to put one anyway.
        let mut spoken = said("Expense: 450 at Blue Tokai using HDFC");
        spoken.source = "manual".into();
        spoken.hints.kind = Some("Expense".into());
        spoken.hints.amount = Some(450.0);
        spoken.hints.account = Some("HDFC".into());
        spoken.hints.to_account = Some("Food & Drink".into());
        spoken.hints.category = Some("Food & Drink > Coffee".into());
        let r = resolve(&conn, &spoken).unwrap();
        assert_eq!(r.category_id, Some(coffee));
        assert_eq!(r.to_account_id, None);
        assert!(r.complete());

        // A transfer: the category names nothing filable, and a transfer is
        // never categorised in any case.
        let mut spoken = said("Transfer: 5000 at  using Federal");
        spoken.source = "manual".into();
        spoken.hints.kind = Some("Transfer".into());
        spoken.hints.amount = Some(5000.0);
        spoken.hints.account = Some("Federal".into());
        spoken.hints.to_account = Some("HDFC".into());
        spoken.hints.category = Some("HDFC > HDFC".into());
        let r = resolve(&conn, &spoken).unwrap();
        assert_eq!(r.kind, "transfer");
        assert_eq!(r.account_id, Some(account_id(&conn, "Federal")));
        assert_eq!(r.to_account_id, Some(account_id(&conn, "HDFC")));
        assert_eq!(r.category_id, None);
        assert!(r.complete(), "a transfer needs no category to be finished");
    }

    /// A note is capitalised and otherwise left alone — what to strip off the
    /// front of it is the model's judgement to make, not a rule here.
    #[test]
    fn a_note_arrives_capitalised() {
        assert_eq!(capitalised("biryani").as_deref(), Some("Biryani"));
        assert_eq!(capitalised("  split with Ravi  ").as_deref(), Some("Split with Ravi"));
        assert_eq!(capitalised("HDFC annual fee").as_deref(), Some("HDFC annual fee"));
        assert_eq!(capitalised("   ").as_deref(), None);
    }

    /// Nothing goes into the ledger half-filed. A capture the book cannot
    /// finish is one that has to be visibly waiting, or it is a posting
    /// nobody will ever come back to — there being nothing to come back to.
    #[test]
    fn an_uncategorised_capture_waits_rather_than_posting() {
        let conn = book();
        let mut spoken = said("Spent 988 using the Swiggy card for biryani");
        spoken.hints.amount = Some(988.0);
        spoken.hints.account = Some("Swiggy".into());
        spoken.hints.merchant = Some("Anterra Kitchen and Bar".into());
        // The reading names no category — nothing may invent one, and nothing
        // may wave it through without one either.
        let r = resolve(&conn, &spoken).unwrap();
        assert_eq!(r.category_id, None);
        assert_eq!(r.unresolved, vec!["category".to_string()]);
        assert!(!r.complete());

        // Name one and it goes.
        spoken.hints.category = Some("Food & Drink > Restaurant".into());
        child(&conn, "Food & Drink", "Restaurant");
        assert!(resolve(&conn, &spoken).unwrap().complete());
    }

    /// A transfer has no category to be missing — it is money between your
    /// own accounts, and the ledger refuses to file one.
    #[test]
    fn a_transfer_needs_no_category_to_be_complete() {
        let conn = book();
        let r = resolve(&conn, &said("moved 5000 from Federal to HDFC")).unwrap();
        assert_eq!(r.kind, "transfer");
        assert!(r.unresolved.is_empty());
        assert!(r.complete());
    }

    /// A reading answers alone: a field the model left empty stays empty
    /// rather than being filled in from the words behind its back.
    #[test]
    fn a_reading_is_not_second_guessed() {
        let conn = book();
        let mut spoken = said("spent 450 for coffee at Blue Tokai using the HDFC card");
        // The sentence marks HDFC plainly, and the reading does not name it.
        spoken.hints.amount = Some(450.0);
        spoken.hints.merchant = Some("Blue Tokai".into());
        let r = resolve(&conn, &spoken).unwrap();
        assert_eq!(r.account_id, None, "the sentence must not fill this in");
        assert_eq!(r.merchant, "Blue Tokai");
        assert!(!r.complete(), "it waits for a person instead");

        // Name it in the reading and it resolves.
        spoken.hints.account = Some("HDFC".into());
        assert_eq!(
            resolve(&conn, &spoken).unwrap().account_id,
            Some(account_id(&conn, "HDFC"))
        );
    }

    /// A leaf name four groups share cannot be resolved from the leaf alone.
    #[test]
    fn an_ambiguous_category_is_left_alone() {
        let conn = book();
        // Two expense groups keep a Gifts, so the leaf alone settles nothing.
        assert_eq!(category_named(&conn, "Gifts", "expense").unwrap(), None);
        // The income tree keeps exactly one, and money coming in can only
        // mean that one.
        assert!(category_named(&conn, "Gifts", "income").unwrap().is_some());
        assert!(category_named(&conn, "Food & Drink > Coffee", "expense").unwrap().is_some());
        // The punctuation dictation actually produces.
        assert!(category_named(&conn, "food and drink coffee", "expense").unwrap().is_some());
        // A top-level category nobody has given children to is filed under by
        // its own name, because that is the whole of its path.
        assert!(category_named(&conn, "Health", "expense").unwrap().is_some());
    }

    /// Shortcuts' date picker has several right answers, and every one of
    /// them is the moment the sentence was said — not the moment it was read.
    #[test]
    fn reads_the_time_however_the_shortcut_wrote_it() {
        let noon = NaiveDate::from_ymd_opt(2026, 9, 19)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let half_past_two = noon.date().and_hms_opt(14, 32, 0).unwrap();
        // The shapes without a zone are the phone's own clock, kept as is.
        assert_eq!(spoken_at("2026-09-19T14:32:00"), Some(half_past_two));
        assert_eq!(spoken_at("2026-09-19T14:32"), Some(half_past_two));
        assert_eq!(spoken_at("2026-09-19 14:32:00"), Some(half_past_two));
        assert_eq!(spoken_at(" 2026-09-19 14:32 "), Some(half_past_two));
        assert_eq!(spoken_at("2026-09-19"), Some(noon));
        // One with a zone is a definite instant; it reads as some local time
        // on the same day, whatever clock this test happens to run under.
        let zoned = spoken_at("2026-09-19T14:32:00+05:30").expect("rfc3339 reads");
        let instant = chrono::DateTime::parse_from_rfc3339("2026-09-19T14:32:00+05:30").unwrap();
        assert_eq!(zoned, instant.with_timezone(&Local).naive_local());
        // And what is not a time at all is nothing, rather than now.
        assert_eq!(spoken_at("yesterday"), None);
        assert_eq!(spoken_at(""), None);
    }

    #[test]
    fn counts_back_from_the_day_it_was_said() {
        let spoken_on = NaiveDate::from_ymd_opt(2026, 9, 1).unwrap(); // a Tuesday
        assert_eq!(day_from(Some("yesterday"), spoken_on), spoken_on - Duration::days(1));
        assert_eq!(day_from(Some("3 days ago"), spoken_on), spoken_on - Duration::days(3));
        assert_eq!(
            day_from(Some("last friday"), spoken_on),
            NaiveDate::from_ymd_opt(2026, 8, 28).unwrap()
        );
        assert_eq!(day_from(None, spoken_on), spoken_on);
    }

    /// Shortcuts appends exactly what it is handed, so whether the objects
    /// are on separate lines depends on a newline nobody can see. Both have
    /// to work, and a line that is not JSON at all is still a sentence.
    #[test]
    fn reads_the_drop_however_it_was_written() {
        let raw = concat!(
            r#"{"said":"spent 450 at blue tokai","at":"2026-09-01T19:30:00+05:30"}"#,
            r#"{"said":"paid 200 for parking","at":"2026-09-01T20:00:00+05:30"}"#,
            "\nbought lunch for 300\n",
        );
        let out = split_captures(raw);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].said, "spent 450 at blue tokai");
        assert_eq!(out[2].said, "bought lunch for 300");
        assert_eq!(out[2].source, "text");
    }

    /// Shortcuts corrects the extension behind you: ask it to append JSON to
    /// `midas-inbox.jsonl` and the file it actually writes is
    /// `midas-inbox.jsonl.json`. The drop is read by what it starts with.
    #[test]
    fn the_drop_is_read_whatever_shortcuts_renamed_it() {
        let conn = book();
        let dir = std::env::temp_dir().join(format!("midas-capture-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let asked_for = dir.join("midas-inbox.jsonl");
        db::set_setting(&conn, INBOX_SETTING, asked_for.to_str().unwrap()).unwrap();

        // Nothing at the name we asked for; the capture is next door.
        std::fs::write(
            dir.join("midas-inbox.jsonl.json"),
            r#"{"said":"spent 450 for coffee at Blue Tokai using the HDFC card","at":"2026-09-01T19:30:00+05:30"}"#,
        )
        .unwrap();

        let result = sync(&conn).unwrap();
        assert_eq!((result.found, result.posted), (1, 1));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The same rule from the other end: a category tapped off a list is
    /// named just as explicitly as one a model read out of a sentence.
    #[test]
    fn a_hand_picked_category_beats_history() {
        let conn = book();
        let coffee = child(&conn, "Food & Drink", "Coffee");
        let clothes = child(&conn, "Shopping", "Clothes");
        db::save_transaction(
            &conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount: 30_000,
                account_id: account_id(&conn, "HDFC"),
                to_account_id: None,
                category_id: Some(coffee.clone()),
                merchant: "Blue Tokai".into(),
                note: None,
                occurred_at: "2026-08-01T10:00".into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
                cashback: None,
            },
        )
        .unwrap();

        let mut spoken = said("Spent 450 at Blue Tokai using HDFC");
        spoken.hints.category = Some("Shopping > Clothes".into());

        // Named in the sentence, however it got there.
        assert_eq!(resolve(&conn, &spoken).unwrap().category_id, Some(clothes.clone()));
        spoken.source = "manual".into();
        assert_eq!(resolve(&conn, &spoken).unwrap().category_id, Some(clothes));
        // And with nothing named, the counterparty's habit answers.
        spoken.hints.category = None;
        assert_eq!(resolve(&conn, &spoken).unwrap().category_id, Some(coffee));
    }

    /// The same sentence said twice is two pieces of money. A line with a
    /// timestamp is told apart by it; a bare one by where it sits in the file.
    #[test]
    fn the_same_sentence_twice_is_two_captures() {
        let conn = book();
        let dir = std::env::temp_dir().join(format!("midas-capture-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let inbox = dir.join("midas-inbox.jsonl");
        db::set_setting(&conn, INBOX_SETTING, inbox.to_str().unwrap()).unwrap();

        // Bare lines, no timestamps, identical words.
        std::fs::write(&inbox, "spent 100 for coffee at chai stall using the hdfc card\n").unwrap();
        assert_eq!(sync(&conn).unwrap().posted, 1);
        std::fs::write(
            &inbox,
            "spent 100 for coffee at chai stall using the hdfc card\n             spent 100 for coffee at chai stall using the hdfc card\n",
        )
        .unwrap();
        let second = sync(&conn).unwrap();
        assert_eq!((second.found, second.posted), (1, 1), "the repeat is money too");

        let posted: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(posted, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The line is kept exactly as the phone wrote it, so a reading you
    /// disagree with can be held against what was actually sent.
    #[test]
    fn the_line_is_kept_as_it_arrived() {
        let line = r#"{"said":"spent 450 for coffee at Blue Tokai using the HDFC card","src":"siri","model":{"amount":450}}"#;
        let out = split_captures(line);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].raw, line);
        assert_eq!(out[0].said, "spent 450 for coffee at Blue Tokai using the HDFC card");
    }

    /// A quote mark inside the sentence breaks the JSON the Shortcut built
    /// around it. The capture still arrives — a ledger may show you something
    /// ugly, but it may never quietly lose money you told it about.
    #[test]
    fn a_broken_line_arrives_rather_than_vanishing() {
        let out = split_captures(r#"{"said":"paid at "the" cafe","at":"2026-09-01T19:30:00+05:30"}"#);
        assert_eq!(out.len(), 1);
        assert!(out[0].said.contains("cafe"));
        assert_eq!(out[0].source, "text");
    }

    /// The model's dictionary, whether the Shortcut nests it or not.
    #[test]
    fn takes_the_models_reading_alongside_the_words() {
        let v: Value = serde_json::from_str(
            r#"{"said":"spent 450 at blue tokai","model":{"amount":"450","account":"HDFC card",
                "category":"Food & Drink > Coffee","merchant":"Blue Tokai","kind":"expense"}}"#,
        )
        .unwrap();
        let spoken = from_json(&v, "{}").unwrap();
        assert_eq!(spoken.hints.amount, Some(450.0));
        assert_eq!(spoken.hints.account.as_deref(), Some("HDFC card"));

        let conn = book();
        // "HDFC card" is not an account; the one account it contains is.
        assert_eq!(
            account_named(&conn, "HDFC card").unwrap(),
            Some(account_id(&conn, "HDFC"))
        );
    }

    /// Reading the drop twice must not write the posting twice — the whole
    /// file is re-read every sync, so this is the only thing standing between
    /// a capture and a duplicate.
    #[test]
    fn the_same_line_is_never_read_twice() {
        let conn = book();
        let dir = std::env::temp_dir().join(format!("midas-capture-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let inbox = dir.join("midas-inbox.jsonl");
        std::fs::write(
            &inbox,
            "{\"said\":\"spent 450 for coffee at Blue Tokai using the HDFC card\",\
              \"at\":\"2026-09-01T19:30:00+05:30\"}\n",
        )
        .unwrap();
        db::set_setting(&conn, INBOX_SETTING, inbox.to_str().unwrap()).unwrap();

        let first = sync(&conn).unwrap();
        assert_eq!((first.found, first.posted, first.pending), (1, 1, 0));
        let second = sync(&conn).unwrap();
        assert_eq!((second.found, second.posted), (0, 0));

        let posted: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(posted, 1);

        assert!(pending(&conn).unwrap().is_empty());

        // It wears Siri and nothing else. Triage is the importer's queue —
        // a spoken posting is not waiting on anybody, and putting it in a
        // queue it never needed only makes the queue mean less.
        let worn: Vec<String> = conn
            .prepare(
                "SELECT l.name FROM transaction_labels tl
                 JOIN labels l ON l.id = tl.label_id ORDER BY l.name",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(worn, vec!["Siri".to_string()]);

        let history = history(&conn).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "posted");
        assert!(history[0].transaction_id.is_some());
        assert_eq!(history[0].amount, 45_000);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// History reads off the posting, not off what was heard: correcting a
    /// transaction has to correct the record of it, or the two disagree.
    #[test]
    fn history_follows_the_posting_it_became() {
        let conn = book();
        let dir = std::env::temp_dir().join(format!("midas-capture-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let inbox = dir.join("midas-inbox.jsonl");
        std::fs::write(
            &inbox,
            "{\"said\":\"spent 450 for coffee at Blue Tokai using the HDFC card\",\
              \"at\":\"2026-09-01T19:30:00+05:30\"}\n",
        )
        .unwrap();
        db::set_setting(&conn, INBOX_SETTING, inbox.to_str().unwrap()).unwrap();
        sync(&conn).unwrap();

        let tx_id = history(&conn).unwrap()[0].transaction_id.clone().unwrap();
        conn.execute(
            "UPDATE transactions SET amount = 99900, merchant = 'Third Wave' WHERE id = ?1",
            params![tx_id],
        )
        .unwrap();

        let after = history(&conn).unwrap();
        assert_eq!(after[0].amount, 99_900);
        assert_eq!(after[0].merchant, "Third Wave");
        // The words are never rewritten, whatever the posting becomes.
        assert!(after[0].said.contains("Blue Tokai"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The phone can only name what the word list names, so the list has to
    /// follow the book rather than the other way round.
    #[test]
    fn the_word_list_follows_the_categories() {
        let conn = book();
        let id = child(&conn, "Health", "Physio");
        assert!(book_text(&conn).unwrap().lines().any(|l| l == "Health > Physio"));

        db::delete_category(&conn, &id, None, false).unwrap();
        let after = book_text(&conn).unwrap();
        assert!(!after.lines().any(|l| l == "Health > Physio"));
        // And Health, having lost its only child, is a filing again.
        assert!(after.lines().any(|l| l == "Health"));
    }

    /// The word list is what the phone's prompt is built out of, so its shape
    /// is a contract: accounts, a rule, then "Group > Sub" a line at a time.
    #[test]
    fn writes_a_word_list_the_shortcut_can_read() {
        let conn = book();
        let text = book_text(&conn).unwrap();
        let mut parts = text.split("---");
        let accounts = parts.next().unwrap();
        let categories = parts.next().unwrap();
        assert!(parts.next().is_some(), "and a section for counterparties");
        assert!(parts.next().is_some(), "and one for the people in your life");
        assert!(accounts.lines().any(|l| l == "HDFC"));
        assert!(categories.lines().any(|l| l == "Food & Drink > Coffee"));
        // A group with children is a heading, and never offered.
        assert!(!categories.lines().any(|l| l == "Food & Drink"));
        // One without them is a filing, and is offered plainly.
        assert!(categories.lines().any(|l| l == "Health"));
    }
}
