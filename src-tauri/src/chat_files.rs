//! Files dropped on the chat that aren't statements: order histories and
//! other exports (JSON, JSON Lines, CSV, text, spreadsheets). Claude reads
//! them with `read_file` to find out more about transactions already in the
//! book, and proposes what it learns with `describe_transactions`, which sets
//! each matched transaction's description and note on one card.

use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

use crate::chat::{card_row, CardRow};
use crate::db;
use crate::models::TransactionPatch;

type Result<T> = std::result::Result<T, String>;

/// The most of a file read off disk.
const MAX_BYTES: u64 = 40 * 1024 * 1024;
/// About how much text one read hands back.
const PAGE_CHARS: usize = 60_000;
/// Records one read hands back when no limit is given.
const PAGE_RECORDS: usize = 200;
/// A field's value longer than this is cut.
const CELL_CHARS: usize = 400;
/// Transactions one describe_transactions card may carry.
pub const MAX_ITEMS: usize = 300;

pub fn read_tool() -> Value {
    json!({
        "name": "read_file",
        "description": "Read a file the user attached to this chat that isn't a statement to import: an order \
            history or other export (JSON, JSON Lines, CSV, TSV, text, HTML, spreadsheet). Nothing is written.\n\
            - JSON: first call with just `path` to get the file's outline (its keys, where the arrays of records \
            are and how long they are, and a sample record). Then read the records with `records` (the dotted \
            path to the array, \"\" when the file itself is the array) and `fields` (dotted paths inside each \
            record; `items[].name` collects a field from every element of an inner array). Page with \
            `offset` and `limit`.\n\
            - Anything else: answers with the text, a page at a time from `offset` (in characters).",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "The file's path exactly as attached." },
                "records": { "type": "string", "description": "JSON only: dotted path to the array of records, e.g. \"data.orders\"; \"\" for a top-level array." },
                "fields": { "type": "array", "items": { "type": "string" }, "description": "JSON only: the fields to take from each record, e.g. [\"order_id\", \"order_time\", \"net_total\", \"restaurant_name\", \"order_items[].name\"]. Leave out to get whole records." },
                "offset": { "type": "integer", "description": "JSON records: the first record (from 0). Other files: the first character." },
                "limit": { "type": "integer", "description": "JSON records: how many (default 200, at most 1000)." }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

pub fn write_tool(note: &str) -> Value {
    json!({
        "name": "describe_transactions",
        "description": format!("Set the description (merchant) and/or note of many transactions at once, each its \
            own: what you learnt about them from an attached file such as an order history. Give only the \
            fields that should change; a note given replaces the old one, so carry over anything in it worth \
            keeping. At most {MAX_ITEMS} per change: propose more in further changes.{note}"),
        "eager_input_streaming": true,
        "input_schema": {
            "type": "object",
            "properties": {
                "source": { "type": "string", "description": "Where this came from, as the user would say it, e.g. \"Swiggy orders\"." },
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "The transaction's id." },
                            "merchant": { "type": "string", "description": "Its new description." },
                            "note": { "type": "string", "description": "Its new note." }
                        },
                        "required": ["id"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["items"],
            "additionalProperties": false
        }
    })
}

// ----------------------------------------------------------------- reading

pub fn read_file(input: &Value, allowed: &HashSet<String>) -> Result<Value> {
    let path = input["path"].as_str().map(str::trim).filter(|p| !p.is_empty()).ok_or("`path` is required.")?;
    if !allowed.contains(path) {
        return Err("Only files attached to this chat can be read. Use the exact path from the attachment.".into());
    }
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.into());
    let meta = std::fs::metadata(path).map_err(|e| format!("{name}: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err(format!("{name} is {} MB, more than can be read.", meta.len() / (1024 * 1024)));
    }
    let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let offset = int(input, "offset").unwrap_or(0).max(0) as usize;

    match ext.as_str() {
        "pdf" | "png" | "jpg" | "jpeg" | "webp" | "gif" => Err(format!(
            "{name} is a document or picture: read it with read_statement if it's a statement."
        )),
        "xls" | "xlsx" | "xlsm" | "ods" => Ok(text_page(&name, &crate::ai::spreadsheet_csv(path)?, offset)),
        _ => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name}: {e}"))?;
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim_start_matches('\u{feff}');
            if text.trim().is_empty() {
                return Err(format!("{name} is empty."));
            }
            match parse_json(text) {
                Some(doc) if ext != "csv" && ext != "tsv" => read_json(&name, &doc, input, offset),
                _ => Ok(text_page(&name, text, offset)),
            }
        }
    }
}

fn int(input: &Value, key: &str) -> Option<i64> {
    match &input[key] {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// A JSON document, or JSON Lines read as an array of them.
fn parse_json(text: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.len() < 2 {
        return None;
    }
    lines.iter().map(|l| serde_json::from_str::<Value>(l).ok()).collect::<Option<Vec<_>>>().map(Value::Array)
}

fn text_page(name: &str, text: &str, offset: usize) -> Value {
    let total = text.chars().count();
    let page: String = text.chars().skip(offset).take(PAGE_CHARS).collect();
    let end = offset + page.chars().count();
    json!({
        "file": name,
        "characters": total,
        "offset": offset,
        "text": page,
        "next_offset": if end < total { json!(end) } else { Value::Null },
    })
}

fn read_json(name: &str, doc: &Value, input: &Value, offset: usize) -> Result<Value> {
    let Some(at) = input["records"].as_str() else {
        let mut out = json!({ "file": name, "outline": outline(doc, 0), "arrays": arrays(doc, "") });
        let whole = doc.to_string();
        if whole.chars().count() <= PAGE_CHARS / 2 {
            out["content"] = doc.clone();
        }
        return Ok(out);
    };
    let found = path_get(doc, at).ok_or_else(|| format!("{name} has nothing at `{at}`."))?;
    let records = found.as_array().ok_or_else(|| format!("`{at}` in {name} isn't an array."))?;
    let limit = int(input, "limit").unwrap_or(PAGE_RECORDS as i64).clamp(1, 1000) as usize;
    let fields: Option<Vec<String>> = input["fields"]
        .as_array()
        .map(|f| f.iter().filter_map(Value::as_str).map(String::from).collect())
        .filter(|f: &Vec<String>| !f.is_empty());

    let mut rows = vec![];
    let mut used = 0;
    let mut end = offset;
    for r in records.iter().skip(offset).take(limit) {
        let row = match &fields {
            Some(fields) => Value::Array(fields.iter().map(|f| cell(&collect(r, f))).collect()),
            None => r.clone(),
        };
        let size = row.to_string().len();
        if used + size > PAGE_CHARS && !rows.is_empty() {
            break;
        }
        used += size;
        rows.push(row);
        end += 1;
    }
    let mut out = json!({
        "file": name,
        "records": records.len(),
        "offset": offset,
        "next_offset": if end < records.len() { json!(end) } else { Value::Null },
    });
    if let Some(f) = fields {
        out["columns"] = json!(f);
    }
    out["row_count"] = json!(rows.len());
    out["rows"] = Value::Array(rows);
    Ok(out)
}

/// The shape of a document: objects as their keys, arrays as their length
/// and first element, values as their type and an example.
fn outline(v: &Value, depth: usize) -> Value {
    match v {
        Value::Object(m) if depth < 5 => {
            Value::Object(m.iter().take(60).map(|(k, v)| (k.clone(), outline(v, depth + 1))).collect::<Map<_, _>>())
        }
        Value::Object(m) => json!(format!("object with {} keys", m.len())),
        Value::Array(a) if a.is_empty() => json!("empty array"),
        Value::Array(a) if depth < 5 => json!({ "array_of": a.len(), "first": outline(&a[0], depth + 1) }),
        Value::Array(a) => json!(format!("array of {}", a.len())),
        Value::String(s) => json!(short(s, 60)),
        other => other.clone(),
    }
}

/// Where the arrays of records are, by dotted path, longest first.
fn arrays(v: &Value, at: &str) -> Vec<Value> {
    let mut out = vec![];
    fn walk(v: &Value, at: &str, depth: usize, out: &mut Vec<(String, usize)>) {
        if depth > 6 {
            return;
        }
        match v {
            Value::Array(a) => {
                if a.iter().any(Value::is_object) {
                    out.push((at.to_string(), a.len()));
                }
                if let Some(first) = a.first() {
                    let inner = if at.is_empty() { "[]".to_string() } else { format!("{at}[]") };
                    walk(first, &inner, depth + 1, out);
                }
            }
            Value::Object(m) => {
                for (k, v) in m {
                    let p = if at.is_empty() { k.clone() } else { format!("{at}.{k}") };
                    walk(v, &p, depth + 1, out);
                }
            }
            _ => {}
        }
    }
    let mut found = vec![];
    walk(v, at, 0, &mut found);
    found.sort_by(|a, b| b.1.cmp(&a.1));
    for (p, n) in found.into_iter().take(12) {
        out.push(json!({ "path": p, "length": n }));
    }
    out
}

/// What a plain dotted path names: `a.b.0.c`.
fn path_get<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = v;
    for seg in path.split('.').map(str::trim).filter(|s| !s.is_empty()) {
        cur = match cur {
            Value::Object(m) => m.get(seg)?,
            Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Every value a field path reaches, where `x[]` steps into each element.
fn collect(v: &Value, path: &str) -> Vec<Value> {
    let mut cur = vec![v.clone()];
    for seg in path.split('.').map(str::trim).filter(|s| !s.is_empty()) {
        let (key, each) = match seg.strip_suffix("[]") {
            Some(k) => (k, true),
            None => (seg, false),
        };
        let mut next = vec![];
        for c in cur {
            let got = if key.is_empty() {
                Some(c)
            } else {
                match &c {
                    Value::Object(m) => m.get(key).cloned(),
                    Value::Array(a) => key.parse::<usize>().ok().and_then(|i| a.get(i).cloned()),
                    _ => None,
                }
            };
            match got {
                Some(Value::Array(a)) if each => next.extend(a),
                Some(Value::Null) | None => {}
                Some(g) => next.push(g),
            }
        }
        cur = next;
    }
    cur
}

fn cell(values: &[Value]) -> Value {
    match values {
        [] => Value::Null,
        [one] => match one {
            Value::String(s) => json!(short(s, CELL_CHARS)),
            Value::Object(_) | Value::Array(_) => json!(short(&one.to_string(), CELL_CHARS)),
            v => v.clone(),
        },
        many => {
            let parts: Vec<String> = many
                .iter()
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                })
                .collect();
            json!(short(&parts.join("; "), CELL_CHARS))
        }
    }
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

// ----------------------------------------------------------------- writing

pub struct Item {
    pub id: String,
    pub merchant: Option<String>,
    pub note: Option<String>,
}

pub fn items(input: &Value) -> Result<Vec<Item>> {
    let list = input["items"].as_array().filter(|a| !a.is_empty()).ok_or("`items` must list at least one transaction.")?;
    if list.len() > MAX_ITEMS {
        return Err(format!("At most {MAX_ITEMS} transactions per change: split it into several."));
    }
    let mut seen = HashSet::new();
    let mut out = vec![];
    for i in list {
        let id = i["id"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or("Each item needs the transaction's `id`.")?;
        if !seen.insert(id.to_string()) {
            return Err(format!("{id} is listed twice: give each transaction once."));
        }
        let text = |k: &str| i[k].as_str().map(|s| s.trim().to_string());
        let merchant = text("merchant").filter(|s| !s.is_empty());
        let note = text("note");
        if merchant.is_none() && note.is_none() {
            return Err(format!("The item for {id} doesn't say what to change."));
        }
        out.push(Item { id: id.to_string(), merchant, note });
    }
    Ok(out)
}

pub fn title(input: &Value) -> Result<String> {
    let n = items(input)?.len();
    let what = if n == 1 { "1 transaction".to_string() } else { format!("{n} transactions") };
    Ok(match input["source"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("Describe {what} from {s}"),
        None => format!("Describe {what}"),
    })
}

/// Each transaction as it is, under what it becomes.
pub fn card_rows(conn: &Connection, input: &Value) -> Result<(Vec<CardRow>, Vec<String>)> {
    let items = items(input)?;
    let mut rows = vec![];
    let mut missing = vec![];
    for it in &items {
        let Some(mut row) = card_row(conn, &it.id) else {
            missing.push(it.id.clone());
            continue;
        };
        if let Some(m) = &it.merchant {
            if *m != row.merchant {
                row.was = Some(std::mem::replace(&mut row.merchant, m.clone()));
            }
        }
        if let Some(n) = &it.note {
            row.note = Some(if n.is_empty() { "Note cleared".into() } else { n.clone() });
        }
        rows.push(row);
    }
    let notes = if missing.is_empty() {
        vec![]
    } else {
        vec![format!("{} of these aren't in the book and will be skipped.", missing.len())]
    };
    Ok((rows, notes))
}

pub fn apply(conn: &Connection, input: &Value) -> Result<Value> {
    let items = items(input)?;
    let mut changed = 0;
    let mut skipped = vec![];
    for it in items {
        let patch = TransactionPatch {
            category_id: None,
            clear_category: None,
            account_id: None,
            merchant: it.merchant,
            note: it.note.clone().filter(|n| !n.is_empty()),
            clear_note: it.note.as_deref().map(str::is_empty).filter(|c| *c),
        };
        match db::update_transactions(conn, std::slice::from_ref(&it.id), patch) {
            Ok(r) if r.changed > 0 => changed += 1,
            _ => skipped.push(it.id),
        }
    }
    Ok(json!({ "changed": changed, "skipped": skipped }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orders() -> Value {
        json!({ "data": { "orders": [
            { "order_id": 1, "order_time": "2026-11-02 20:11:00", "net_total": 412.5,
              "restaurant_name": "Meghana Foods", "order_items": [ { "name": "Biryani" }, { "name": "Raita" } ] },
            { "order_id": 2, "order_time": "2026-11-05 13:02:00", "net_total": 189,
              "restaurant_name": "Third Wave", "order_items": [ { "name": "Latte" } ] }
        ] } })
    }

    #[test]
    fn a_json_export_is_outlined_then_read_by_field() {
        let doc = orders();
        let out = read_json("o.json", &doc, &json!({}), 0).unwrap();
        assert_eq!(out["arrays"][0]["path"], "data.orders");
        assert_eq!(out["arrays"][0]["length"], 2);
        assert_eq!(out["outline"]["data"]["orders"]["array_of"], 2);

        let q = json!({ "records": "data.orders", "fields": ["order_time", "net_total", "restaurant_name", "order_items[].name"] });
        let out = read_json("o.json", &doc, &q, 0).unwrap();
        assert_eq!(out["records"], 2);
        assert_eq!(out["rows"][0], json!(["2026-11-02 20:11:00", 412.5, "Meghana Foods", "Biryani; Raita"]));
        assert_eq!(out["rows"][1][3], "Latte");
        assert!(out["next_offset"].is_null());

        let paged = read_json("o.json", &doc, &json!({ "records": "data.orders", "limit": 1 }), 0).unwrap();
        assert_eq!(paged["next_offset"], 1);
        assert_eq!(paged["rows"][0]["order_id"], 1);
    }

    #[test]
    fn json_lines_read_as_an_array() {
        let doc = parse_json("{\"a\":1}\n{\"a\":2}\n").unwrap();
        assert_eq!(doc, json!([{ "a": 1 }, { "a": 2 }]));
        let out = read_json("o.jsonl", &doc, &json!({ "records": "", "fields": ["a"] }), 0).unwrap();
        assert_eq!(out["rows"], json!([[1], [2]]));
    }

    #[test]
    fn items_must_say_something() {
        assert!(items(&json!({ "items": [{ "id": "a" }] })).is_err());
        assert!(items(&json!({ "items": [{ "id": "a", "note": "x" }, { "id": "a", "note": "y" }] })).is_err());
        assert_eq!(title(&json!({ "source": "Swiggy orders", "items": [{ "id": "a", "merchant": "Swiggy · Meghana" }] })).unwrap(),
            "Describe 1 transaction from Swiggy orders");
    }
}
