//! The rest of the app, for the chat: debts, labels, folders, categories,
//! accounts and cards, planned payments, templates, tax heads, triage,
//! captures and investments.
//!
//! Each area is one tool with an `action`, and every action calls the very
//! function the app's own sheet calls, with the same input, so whatever the
//! app checks it checks here too. Like the other changes, none of them runs
//! when Claude asks: the chat shows a card for each, and only the ones the
//! user applies are made.
//!
//! Fields are written in snake_case, the way the rest of the chat's tools
//! are, and turned into the app's own camelCase input on the way in.

use crate::chat::{card_rows, category_label, inr, name_of, posting_line, Card, CardField, CardRow};
use crate::models::*;
use crate::{capture, cards, db, folders, plans, tax};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};

type Result<T> = std::result::Result<T, String>;

/// Every tool here, with the actions it takes.
const TOOLS: &[(&str, &[&str])] = &[
    ("debts", &["save", "delete", "payment", "delete_payment", "addition", "delete_addition", "person_repayment", "delete_person_repayment"]),
    ("labels", &["save", "delete"]),
    ("folders", &["save", "delete", "add", "remove"]),
    ("categories", &["save", "delete", "move_transactions", "tax_tag"]),
    ("accounts", &["save", "archive", "delete", "card_terms", "delete_card_terms"]),
    ("plans", &["save", "delete", "archive", "skip", "pay", "link", "unlink"]),
    ("templates", &["save", "delete"]),
    ("investments", &["save_holding", "delete_holding", "save_lot", "delete_lot"]),
    ("captures", &["post", "dismiss"]),
    ("mark_reviewed", &[]),
];

pub fn is_action(name: &str) -> bool {
    TOOLS.iter().any(|(t, _)| *t == name)
}

fn action_of(name: &str, input: &Value) -> Result<String> {
    let actions = TOOLS.iter().find(|(t, _)| *t == name).map(|(_, a)| *a).unwrap_or(&[]);
    if actions.is_empty() {
        return Ok(String::new());
    }
    let a = input["action"].as_str().unwrap_or("").trim().to_string();
    if !actions.contains(&a.as_str()) {
        return Err(format!("`action` must be one of: {}.", actions.join(", ")));
    }
    Ok(a)
}

// ------------------------------------------------------------------ tools

pub fn tools(note: &str) -> Vec<Value> {
    let tool = |name: &str, description: String, actions: &[&str]| {
        let mut props = Map::new();
        if !actions.is_empty() {
            props.insert("action".into(), json!({ "type": "string", "enum": actions }));
        }
        json!({
            "name": name,
            "description": description,
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": props,
                "required": if actions.is_empty() { json!([]) } else { json!(["action"]) },
                "additionalProperties": true
            }
        })
    };
    let replace = " A save with an `id` replaces that record whole: read its current row first and pass \
                   every field, changed or not. Without an `id` it creates one.";
    vec![
        tool(
            "debts",
            format!(
                "Debts kept by person (tables debts, debt_payments, debt_additions).{note}{replace} Actions:\n\
                 - save: {{id?, direction: lent|borrowed, counterparty, principal (paise), opened_on (YYYY-MM-DD), \
                   due_on?, note?, settled?}}. A debt that is part of a transaction (a shared bill, or a whole \
                   bill someone owes you) is not made here: give that transaction `shares` with edit_transaction.\n\
                 - delete: {{id}}\n\
                 - payment: {{id?, debt_id, amount, occurred_at, note?, transaction_id?, cash_account_id?}} — money \
                   back against one debt. transaction_id links a posting already in the book; otherwise \
                   cash_account_id says which account it moved through, or leave both out to record it alone.\n\
                 - delete_payment: {{id}}\n\
                 - addition: same fields as payment — more lent or borrowed on a debt already open.\n\
                 - delete_addition: {{id}}\n\
                 - person_repayment: {{direction: lent|borrowed, counterparty, amount, occurred_at, note?, \
                   transaction_id?, cash_account_id?}} — one repayment spread over everything a person owes, \
                   oldest first, the way the Debts screen records \"Ravi paid me back\".\n\
                 - delete_person_repayment: {{id}} (the spread id debt_payments.spread_id)"
            ),
            &["save", "delete", "payment", "delete_payment", "addition", "delete_addition", "person_repayment", "delete_person_repayment"],
        ),
        tool(
            "labels",
            format!(
                "Labels (table labels).{note}{replace} Actions:\n\
                 - save: {{id?, name, color (#RRGGBB), silent? (kept off the row in the ledger)}}\n\
                 - delete: {{id}} — the label comes off everything wearing it.\n\
                 Pin or take a label off transactions with label_transactions."
            ),
            &["save", "delete"],
        ),
        tool(
            "folders",
            format!(
                "Folders that keep transactions together (tables folders, folder_transactions).{note}{replace} Actions:\n\
                 - save: {{id?, name, color (#RRGGBB), icon (a lucide icon name such as folder, plane, house, \
                   gift, briefcase), note?}}\n\
                 - delete: {{id}} — the transactions in it stay.\n\
                 - add: {{folder_id, ids}} / remove: {{folder_id, ids}}"
            ),
            &["save", "delete", "add", "remove"],
        ),
        tool(
            "categories",
            format!(
                "Categories (table categories; tax heads in tax_map).{note}{replace} Actions:\n\
                 - save: {{id?, kind: expense|income, name, icon (a lucide icon name), color (#RRGGBB), \
                   parent_id?}} — rename, recolour or move one under another group.\n\
                 - delete: {{id, reassign_to?, delete_children?}} — its transactions move to reassign_to, \
                   or are left uncategorised.\n\
                 - move_transactions: {{from, to, include_children?}} — refile everything in one category.\n\
                 - tax_tag: {{category_id, tag?}} — the tax head it counts toward; leave tag out to clear it."
            ),
            &["save", "delete", "move_transactions", "tax_tag"],
        ),
        tool(
            "accounts",
            format!(
                "Accounts and cards (tables accounts, card_terms).{note}{replace} Actions:\n\
                 - save: {{id?, name, kind: bank|credit|cash|wallet|investment, institution?, opening_balance \
                   (paise; negative for a card's opening dues), color (#RRGGBB), icon (a lucide icon name)}}\n\
                 - archive: {{id, archived}}\n\
                 - delete: {{id}} — deletes the account AND every transaction in it. Prefer archive.\n\
                 - card_terms: {{account_id, effective_on (YYYY-MM-DD), credit_limit?, statement_day?, \
                   due_day?, cashback_rate_e4? (percent × 100, e.g. 150 = 1.5%), cashback_cap? (paise per \
                   statement), note?}} — a credit card's terms from a date on.\n\
                 - delete_card_terms: {{id}}"
            ),
            &["save", "archive", "delete", "card_terms", "delete_card_terms"],
        ),
        tool(
            "plans",
            format!(
                "Planned payments: bills, subscriptions, salary (tables plans, plan_entries).{note}{replace} Actions:\n\
                 - save: {{id?, name, kind: expense|income|transfer, amount, account_id?, to_account_id?, \
                   category_id?, merchant, note?, cadence: weekly|fortnightly|monthly|quarterly|half_yearly|yearly, \
                   every? (1 = every cycle), anchor_on (a date it falls on), ends_on?, archived?}}\n\
                 - delete: {{id}} / archive: {{id, archived}} / skip: {{id}} — let the cycle now due go unpaid.\n\
                 - pay: {{id, transaction: {{kind, amount, account_id, to_account_id?, category_id?, merchant, \
                   note?, occurred_at}}}} — write the posting for the cycle due and mark it paid.\n\
                 - link: {{plan_id, ids}} — past postings that were this plan's payments.\n\
                 - unlink: {{plan_id, transaction_id}}"
            ),
            &["save", "delete", "archive", "skip", "pay", "link", "unlink"],
        ),
        tool(
            "templates",
            format!(
                "Transaction templates (tables transaction_templates, template_splits, template_labels).{note}{replace} \
                 Actions:\n\
                 - save: {{id?, name, kind, amount (0 to ask each time), account_id?, to_account_id?, category_id?, \
                   merchant, note?, splits?: [{{amount, category_id, note?}}], label_ids?}}\n\
                 - delete: {{id}}"
            ),
            &["save", "delete"],
        ),
        tool(
            "investments",
            format!(
                "Mutual funds, gold, FDs and RDs (tables holdings, investment_lots).{note}{replace} Actions:\n\
                 - save_holding: {{id?, kind: gold|fund|fd|rd, name, account_id?, scheme_code? (funds), isin?, \
                   purity_e4? and grams_e4? (gold, × 10000), acquired_on?, rate_e4? (FD/RD interest % × 10000), \
                   opened_on?, matures_on?, instalment? (RD, paise), note?, closed?}}\n\
                 - delete_holding: {{id}}\n\
                 - save_lot: {{id?, holding_id, kind: buy|sell, quantity_e4 (units or grams × 10000), amount \
                   (paise), occurred_at, allotted_at?, note?, cash_account_id?, transaction_id?}}\n\
                 - delete_lot: {{id}}"
            ),
            &["save_holding", "delete_holding", "save_lot", "delete_lot"],
        ),
        tool(
            "captures",
            format!(
                "Transactions dictated to Siri, waiting to be filed (table captures, status pending).{note} Actions:\n\
                 - post: {{id, transaction: {{kind, amount, account_id, to_account_id?, category_id?, merchant, \
                   note?, occurred_at}}}} — file it as a transaction.\n\
                 - dismiss: {{id}}"
            ),
            &["post", "dismiss"],
        ),
        tool(
            "mark_reviewed",
            format!(
                "Mark transactions as reviewed: takes the Triage label off and teaches the importer their \
                 filing, like Mark reviewed in the ledger. {{ids}}.{note}"
            ),
            &[],
        ),
    ]
}

// ------------------------------------------------------------ the input

fn camel_key(k: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in k.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn camel(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (camel_key(k), camel(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(camel).collect()),
        v => v.clone(),
    }
}

/// The app's own input, out of what Claude sent.
fn parse<T: DeserializeOwned>(input: &Value) -> Result<T> {
    let mut v = input.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("action");
    }
    serde_json::from_value(camel(&v)).map_err(|e| format!("The change doesn't fit what the app expects: {e}"))
}

/// An optional list or value, in the app's own shape.
pub(crate) fn opt_parse<T: DeserializeOwned>(v: &Value) -> Result<Option<T>> {
    if v.is_null() {
        return Ok(None);
    }
    serde_json::from_value(camel(v)).map(Some).map_err(|e| format!("The change doesn't fit what the app expects: {e}"))
}

pub(crate) fn parse_transaction(input: &Value) -> Result<TransactionInput> {
    let mut v = input.clone();
    if let Some(o) = v.as_object_mut() {
        o.entry("id").or_insert(Value::Null);
        o.entry("merchant").or_insert(json!(""));
    }
    parse(&v)
}

fn s(input: &Value, key: &str) -> Result<String> {
    input[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("`{key}` is required."))
}

fn ids(input: &Value) -> Result<Vec<String>> {
    let ids: Vec<String> = input["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err("`ids` must list at least one transaction.".into());
    }
    Ok(ids)
}

fn flag(input: &Value, key: &str) -> bool {
    input[key].as_bool().unwrap_or(false)
}

// ------------------------------------------------------- describing it

fn counterparty(conn: &Connection, debt: &str) -> String {
    conn.query_row(
        "SELECT counterparty, principal FROM debts WHERE id = ?1",
        [debt],
        |r| Ok(format!("{} ({})", r.get::<_, String>(0)?, inr(r.get::<_, i64>(1)?))),
    )
    .unwrap_or_else(|_| format!("unknown debt ({debt})"))
}

fn count(conn: &Connection, sql: &str, id: &str) -> i64 {
    conn.query_row(sql, [id], |r| r.get(0)).unwrap_or(0)
}

/// A value as the card shows it: ids as names, paise as rupees.
fn shown(conn: &Connection, tool: &str, key: &str, v: &Value) -> Option<String> {
    let text = match v {
        Value::Null => return None,
        Value::Bool(b) => return Some(if *b { "Yes".into() } else { "No".into() }),
        Value::String(s) if s.trim().is_empty() => return None,
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let int = v.as_i64();
    Some(match key {
        "account_id" | "to_account_id" | "cash_account_id" => name_of(conn, "accounts", &text),
        "category_id" | "parent_id" | "reassign_to" => category_label(conn, &text),
        "from" | "to" if tool == "categories" => category_label(conn, &text),
        "folder_id" => name_of(conn, "folders", &text),
        "plan_id" => name_of(conn, "plans", &text),
        "holding_id" => name_of(conn, "holdings", &text),
        "debt_id" => counterparty(conn, &text),
        "transaction_id" => posting_line(conn, &text),
        "amount" | "principal" | "opening_balance" | "credit_limit" | "cashback_cap" | "instalment" => {
            match int {
                Some(p) if p < 0 => format!("−{}", inr(-p)),
                Some(p) => inr(p),
                None => text,
            }
        }
        "cashback_rate_e4" => int.map(|r| format!("{}%", r as f64 / 100.0)).unwrap_or(text),
        "rate_e4" => int.map(|r| format!("{}%", r as f64 / 10_000.0)).unwrap_or(text),
        k if k.ends_with("_e4") => int.map(|r| format!("{}", r as f64 / 10_000.0)).unwrap_or(text),
        "color" => text.to_uppercase(),
        _ => text,
    })
}

fn heading(key: &str) -> String {
    let words = match key {
        "account_id" => "Account",
        "to_account_id" => "To account",
        "cash_account_id" => "Through account",
        "category_id" => "Category",
        "parent_id" => "Sits under",
        "reassign_to" => "Move its transactions to",
        "folder_id" => "Folder",
        "plan_id" => "Plan",
        "holding_id" => "Holding",
        "debt_id" => "Debt",
        "transaction_id" => "Transaction",
        "merchant" => "Description",
        "occurred_at" => "Date",
        "opened_on" => "Opened",
        "due_on" => "Due",
        "anchor_on" => "Falls on",
        "ends_on" => "Ends",
        "effective_on" => "From",
        "cashback_rate_e4" => "Cashback",
        "cashback_cap" => "Cashback cap",
        "rate_e4" => "Interest",
        "grams_e4" => "Grams",
        "purity_e4" => "Purity",
        "quantity_e4" => "Quantity",
        "include_children" => "Sub-categories too",
        "delete_children" => "Delete sub-categories",
        k => {
            let mut t = k.replace('_', " ");
            if let Some(f) = t.get_mut(..1) {
                f.make_ascii_uppercase();
            }
            return t;
        }
    };
    words.into()
}

/// The row a save is about to replace, column by column, as the card shows
/// each value — what the "from" side of a field reads.
fn current(conn: &Connection, tool: &str, table: &str, id: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(mut stmt) = conn.prepare(&format!("SELECT * FROM {table} WHERE id = ?1")) else { return out };
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let _ = stmt.query_row([id], |r| {
        for (i, n) in names.iter().enumerate() {
            let v = match r.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(n) => json!(n),
                rusqlite::types::ValueRef::Real(f) => json!(f),
                rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            out.insert(n.clone(), v);
        }
        Ok(())
    });
    let _ = tool;
    out
}

fn table_of(tool: &str, action: &str) -> Option<&'static str> {
    Some(match (tool, action) {
        ("debts", "save") => "debts",
        ("debts", "payment") => "debt_payments",
        ("debts", "addition") => "debt_additions",
        ("labels", "save") => "labels",
        ("folders", "save") => "folders",
        ("categories", "save") => "categories",
        ("accounts", "save") => "accounts",
        ("plans", "save") => "plans",
        ("templates", "save") => "transaction_templates",
        ("investments", "save_holding") => "holdings",
        ("investments", "save_lot") => "investment_lots",
        _ => return None,
    })
}

fn a_transaction(conn: &Connection, t: &Value) -> Option<CardRow> {
    let kind = t["kind"].as_str()?.to_string();
    let account = t["account_id"].as_str().map(|a| name_of(conn, "accounts", a)).unwrap_or_default();
    Some(CardRow {
        date: t["occurred_at"].as_str().map(|d| d.chars().take(10).collect()).unwrap_or_default(),
        merchant: t["merchant"].as_str().unwrap_or("").to_string(),
        amount: t["amount"].as_i64().unwrap_or(0),
        account: match t["to_account_id"].as_str() {
            Some(to) if kind == "transfer" => format!("{account} → {}", name_of(conn, "accounts", to)),
            _ => account,
        },
        filed: if kind == "transfer" {
            "Transfer".into()
        } else {
            t["category_id"].as_str().map(|c| category_label(conn, c)).unwrap_or_else(|| "No category".into())
        },
        kind,
    })
}

/// What the change is, for its card and for the history once it's done.
pub fn describe(conn: &Connection, tool: &str, input: &Value) -> Result<(String, Card)> {
    if !input.is_object() {
        return Err("The change didn't come through in a form that can be read.".into());
    }
    let action = action_of(tool, input)?;
    let id = input["id"].as_str().filter(|s| !s.is_empty());
    let mut card = Card {
        action: if action.starts_with("delete") || action == "dismiss" {
            "delete"
        } else if action.starts_with("save") && id.is_none() {
            "add"
        } else if action.starts_with("save") {
            "edit"
        } else {
            "change"
        },
        ..Card::default()
    };

    // Fields, with what a save replaces where there is a row to replace.
    let was = match (id, table_of(tool, &action)) {
        (Some(id), Some(table)) => current(conn, tool, table, id),
        _ => Map::new(),
    };
    for (k, v) in input.as_object().into_iter().flatten() {
        if matches!(k.as_str(), "action" | "id" | "ids" | "transaction" | "splits" | "label_ids" | "spread_id") {
            continue;
        }
        let Some(to) = shown(conn, tool, k, v) else { continue };
        let from = was.get(k).and_then(|w| shown(conn, tool, k, w));
        if from.as_deref() == Some(to.as_str()) && id.is_some() {
            continue; // unchanged, and the card is about what changes
        }
        card.fields.push(CardField { name: heading(k), from, to });
    }
    if let Some(splits) = input["splits"].as_array() {
        for p in splits {
            card.fields.push(CardField {
                name: "Split".into(),
                from: None,
                to: format!(
                    "{} · {}",
                    inr(p["amount"].as_i64().unwrap_or(0)),
                    p["category_id"].as_str().map(|c| category_label(conn, c)).unwrap_or_else(|| "No category".into())
                ),
            });
        }
    }
    if let Some(labels) = input["label_ids"].as_array() {
        let names: Vec<String> =
            labels.iter().filter_map(Value::as_str).map(|l| name_of(conn, "labels", l)).collect();
        card.fields.push(CardField { name: "Labels".into(), from: None, to: names.join(", ") });
    }
    if let Some(t) = input.get("transaction") {
        card.rows.extend(a_transaction(conn, t));
    }
    if input.get("ids").is_some() {
        (card.rows, card.more) = card_rows(conn, &ids(input)?);
    }
    if tool == "debts" && action == "delete" {
        if let Some(id) = id {
            card.fields.push(CardField { name: "Debt".into(), from: None, to: counterparty(conn, id) });
        }
    }

    let name = |table: &str| id.map(|i| name_of(conn, table, i)).unwrap_or_default();
    let new_name = input["name"].as_str().unwrap_or("").to_string();
    let title = match (tool, action.as_str()) {
        ("debts", "save") => {
            let who = input["counterparty"].as_str().unwrap_or("someone");
            let amount = inr(input["principal"].as_i64().unwrap_or(0));
            match (id, input["direction"].as_str()) {
                (Some(_), _) => format!("Edit the debt with {who}"),
                (None, Some("borrowed")) => format!("Borrowed {amount} from {who}"),
                _ => format!("Lent {amount} to {who}"),
            }
        }
        ("debts", "delete") => format!("Delete the debt with {}", id.map(|i| counterparty(conn, i)).unwrap_or_default()),
        ("debts", "payment") => format!(
            "Record {} paid back on {}",
            inr(input["amount"].as_i64().unwrap_or(0)),
            input["debt_id"].as_str().map(|d| counterparty(conn, d)).unwrap_or_default()
        ),
        ("debts", "addition") => format!(
            "Add {} to {}",
            inr(input["amount"].as_i64().unwrap_or(0)),
            input["debt_id"].as_str().map(|d| counterparty(conn, d)).unwrap_or_default()
        ),
        ("debts", "person_repayment") => {
            let who = input["counterparty"].as_str().unwrap_or("someone");
            let amount = inr(input["amount"].as_i64().unwrap_or(0));
            if input["direction"].as_str() == Some("borrowed") {
                format!("You paid {who} back {amount}")
            } else {
                format!("{who} paid you back {amount}")
            }
        }
        ("debts", "delete_payment") => "Delete a repayment".into(),
        ("debts", "delete_addition") => "Delete an addition to a debt".into(),
        ("debts", "delete_person_repayment") => "Delete a repayment".into(),
        ("labels", "save") if id.is_some() => format!("Edit the label “{}”", name("labels")),
        ("labels", "save") => format!("New label “{new_name}”"),
        ("labels", "delete") => format!("Delete the label “{}”", name("labels")),
        ("folders", "save") if id.is_some() => format!("Edit the folder “{}”", name("folders")),
        ("folders", "save") => format!("New folder “{new_name}”"),
        ("folders", "delete") => format!("Delete the folder “{}”", name("folders")),
        ("folders", "add") | ("folders", "remove") => {
            let folder = input["folder_id"].as_str().map(|f| name_of(conn, "folders", f)).unwrap_or_default();
            let n = input["ids"].as_array().map(Vec::len).unwrap_or(0);
            let what = if n == 1 { "1 transaction".to_string() } else { format!("{n} transactions") };
            if action == "add" { format!("Put {what} in “{folder}”") } else { format!("Take {what} out of “{folder}”") }
        }
        ("categories", "save") if id.is_some() => {
            format!("Edit the category “{}”", id.map(|i| category_label(conn, i)).unwrap_or_default())
        }
        ("categories", "save") => format!("New category “{new_name}”"),
        ("categories", "delete") => {
            let id = id.unwrap_or_default();
            let n = count(conn, "SELECT COUNT(*) FROM transactions WHERE category_id = ?1", id);
            format!("Delete the category “{}” ({n} transactions in it)", category_label(conn, id))
        }
        ("categories", "move_transactions") => format!(
            "Move everything in {} to {}",
            input["from"].as_str().map(|c| category_label(conn, c)).unwrap_or_default(),
            input["to"].as_str().map(|c| category_label(conn, c)).unwrap_or_default()
        ),
        ("categories", "tax_tag") => format!(
            "Set the tax head of {}",
            input["category_id"].as_str().map(|c| category_label(conn, c)).unwrap_or_default()
        ),
        ("accounts", "save") if id.is_some() => format!("Edit the account “{}”", name("accounts")),
        ("accounts", "save") => format!("New account “{new_name}”"),
        ("accounts", "archive") => {
            let verb = if flag(input, "archived") { "Archive" } else { "Bring back" };
            format!("{verb} “{}”", name("accounts"))
        }
        ("accounts", "delete") => {
            let id = id.unwrap_or_default();
            let n = count(conn, "SELECT COUNT(*) FROM transactions WHERE account_id = ?1 OR to_account_id = ?1", id);
            format!("Delete the account “{}” and its {n} transactions", name_of(conn, "accounts", id))
        }
        ("accounts", "card_terms") => format!(
            "Set the terms of {}",
            input["account_id"].as_str().map(|a| name_of(conn, "accounts", a)).unwrap_or_default()
        ),
        ("accounts", "delete_card_terms") => "Delete a card's terms".into(),
        ("plans", "save") if id.is_some() => format!("Edit the plan “{}”", name("plans")),
        ("plans", "save") => format!("New planned payment “{new_name}”"),
        ("plans", "delete") => format!("Delete the plan “{}”", name("plans")),
        ("plans", "archive") => {
            let verb = if flag(input, "archived") { "Archive" } else { "Bring back" };
            format!("{verb} the plan “{}”", name("plans"))
        }
        ("plans", "skip") => format!("Skip this cycle of “{}”", name("plans")),
        ("plans", "pay") => format!("Pay this cycle of “{}”", name("plans")),
        ("plans", "link") => format!(
            "Link payments to “{}”",
            input["plan_id"].as_str().map(|p| name_of(conn, "plans", p)).unwrap_or_default()
        ),
        ("plans", "unlink") => format!(
            "Unlink a payment from “{}”",
            input["plan_id"].as_str().map(|p| name_of(conn, "plans", p)).unwrap_or_default()
        ),
        ("templates", "save") if id.is_some() => format!("Edit the template “{}”", name("transaction_templates")),
        ("templates", "save") => format!("New template “{new_name}”"),
        ("templates", "delete") => format!("Delete the template “{}”", name("transaction_templates")),
        ("investments", "save_holding") if id.is_some() => format!("Edit “{}”", name("holdings")),
        ("investments", "save_holding") => format!("New holding “{new_name}”"),
        ("investments", "delete_holding") => format!("Delete “{}” and its buys and sells", name("holdings")),
        ("investments", "save_lot") => format!(
            "Record a {} of {}",
            if input["kind"].as_str() == Some("sell") { "sale" } else { "purchase" },
            input["holding_id"].as_str().map(|h| name_of(conn, "holdings", h)).unwrap_or_default()
        ),
        ("investments", "delete_lot") => "Delete a buy or sell".into(),
        ("captures", "post") => "File a Siri capture".into(),
        ("captures", "dismiss") => "Dismiss a Siri capture".into(),
        ("mark_reviewed", _) => {
            let n = input["ids"].as_array().map(Vec::len).unwrap_or(0);
            if n == 1 { "Mark 1 transaction reviewed".into() } else { format!("Mark {n} transactions reviewed") }
        }
        (t, a) => format!("{t}: {a}"),
    };
    Ok((title, card))
}

// ------------------------------------------------------------ doing it

pub fn apply(conn: &Connection, tool: &str, input: &Value) -> Result<Value> {
    let action = action_of(tool, input)?;
    let id = || s(input, "id");
    let done = match (tool, action.as_str()) {
        ("debts", "save") => db::save_debt(conn, parse(input)?).map(|_| json!({}))?,
        ("debts", "delete") => db::delete_debt(conn, &id()?).map(|_| json!({}))?,
        ("debts", "payment") => db::save_debt_payment(conn, parse(input)?).map(|_| json!({}))?,
        ("debts", "delete_payment") => db::delete_debt_payment(conn, &id()?).map(|_| json!({}))?,
        ("debts", "addition") => db::save_debt_addition(conn, parse(input)?).map(|_| json!({}))?,
        ("debts", "delete_addition") => db::delete_debt_addition(conn, &id()?).map(|_| json!({}))?,
        ("debts", "person_repayment") => {
            json!({ "spread_id": db::save_person_repayment(conn, parse(input)?)? })
        }
        ("debts", "delete_person_repayment") => db::delete_person_repayment(conn, &id()?).map(|_| json!({}))?,
        ("labels", "save") => json!({ "id": db::save_label(conn, parse(input)?)?.id }),
        ("labels", "delete") => db::delete_label(conn, &id()?).map(|_| json!({}))?,
        ("folders", "save") => json!({ "id": folders::save_folder(conn, parse(input)?)?.id }),
        ("folders", "delete") => folders::delete_folder(conn, &id()?).map(|_| json!({}))?,
        ("folders", "add") => json!({ "added": folders::add_postings(conn, &s(input, "folder_id")?, &ids(input)?)? }),
        ("folders", "remove") => folders::remove_postings(conn, &s(input, "folder_id")?, &ids(input)?).map(|_| json!({}))?,
        ("categories", "save") => json!({ "id": db::save_category(conn, parse(input)?)?.id }),
        ("categories", "delete") => db::delete_category(
            conn,
            &id()?,
            input["reassign_to"].as_str().filter(|s| !s.is_empty()).map(String::from),
            flag(input, "delete_children"),
        )
        .map(|_| json!({}))?,
        ("categories", "move_transactions") => json!({
            "moved": db::reassign_category(conn, &s(input, "from")?, &s(input, "to")?, flag(input, "include_children"))?
        }),
        ("categories", "tax_tag") => tax::set_tax_tag(
            conn,
            &s(input, "category_id")?,
            input["tag"].as_str().map(String::from),
        )
        .map(|_| json!({}))?,
        ("accounts", "save") => json!({ "id": db::save_account(conn, parse(input)?)?.id }),
        ("accounts", "archive") => db::set_account_archived(conn, &id()?, flag(input, "archived")).map(|_| json!({}))?,
        ("accounts", "delete") => db::delete_account(conn, &id()?).map(|_| json!({}))?,
        ("accounts", "card_terms") => {
            let term = cards::save_card_term(
                conn,
                &s(input, "account_id")?,
                &s(input, "effective_on")?,
                input["credit_limit"].as_i64(),
                input["statement_day"].as_i64(),
                input["due_day"].as_i64(),
                input["cashback_rate_e4"].as_i64(),
                input["cashback_cap"].as_i64(),
                input["note"].as_str(),
            )?;
            json!({ "id": term.id })
        }
        ("accounts", "delete_card_terms") => cards::delete_card_term(conn, &id()?).map(|_| json!({}))?,
        ("plans", "save") => json!({ "id": plans::save_plan(conn, parse(input)?)?.id }),
        ("plans", "delete") => plans::delete_plan(conn, &id()?).map(|_| json!({}))?,
        ("plans", "archive") => plans::set_plan_archived(conn, &id()?, flag(input, "archived")).map(|_| json!({}))?,
        ("plans", "skip") => plans::skip_plan(conn, &id()?).map(|_| json!({}))?,
        ("plans", "pay") => {
            let tx = parse_transaction(&input["transaction"])?;
            json!({ "transaction_id": plans::pay_plan(conn, &id()?, tx)?.id })
        }
        ("plans", "link") => json!({ "linked": plans::link_postings(conn, &s(input, "plan_id")?, &ids(input)?)? }),
        ("plans", "unlink") => {
            plans::unlink_posting(conn, &s(input, "plan_id")?, &s(input, "transaction_id")?).map(|_| json!({}))?
        }
        ("templates", "save") => json!({ "id": db::save_template(conn, parse(input)?)?.id }),
        ("templates", "delete") => db::delete_template(conn, &id()?).map(|_| json!({}))?,
        ("investments", "save_holding") => db::save_holding(conn, parse(input)?).map(|_| json!({}))?,
        ("investments", "delete_holding") => db::delete_holding(conn, &id()?).map(|_| json!({}))?,
        ("investments", "save_lot") => db::save_investment_lot(conn, parse(input)?).map(|_| json!({}))?,
        ("investments", "delete_lot") => db::delete_investment_lot(conn, &id()?).map(|_| json!({}))?,
        ("captures", "post") => {
            let tx = parse_transaction(&input["transaction"])?;
            json!({ "transaction_id": capture::post(conn, &id()?, tx)?.id })
        }
        ("captures", "dismiss") => capture::dismiss(conn, &id()?).map(|_| json!({}))?,
        ("mark_reviewed", _) => json!({ "reviewed": db::confirm_triage(conn, &ids(input)?)? }),
        (t, a) => return Err(format!("There is no {t} action called {a}.")),
    };
    Ok(done)
}
