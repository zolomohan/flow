//! Claude reads a capture: a typed or dictated sentence, a bank SMS, or a
//! screenshot of a payment.
//!
//! Claude only *reads*. What it hands back is the same reading the phone's
//! Shortcut used to send beside the sentence (kind, amount, account, category,
//! merchant, day, note), named in this book's own words, and `capture.rs`
//! resolves and files it exactly as it files any other capture. So the rules
//! about what may go into the ledger unaided stay in one place.
//!
//! Three things are new to Claude's reading and have no Shortcut equivalent:
//! whether the text is a transaction at all (an OTP or a balance alert is
//! not), whether it is one already in the book (the SMS and the screenshot of
//! one payment), and whether Claude is sure.

use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai;
use crate::capture;
use crate::db::{oops, Result};

/// Faster than the model Ask uses: a capture should land while Siri is still
/// listening, and reading one line needs no deep thought.
pub const MODEL: &str = "claude-sonnet-5-5";

/// How long a capture waits for Claude before it is filed without it.
const TIMEOUT: Duration = Duration::from_secs(25);

/// How many recent postings Claude sees, to spot a capture already in the book.
const RECENT: usize = 30;

/// Everything about this book Claude is told, taken under the lock so the
/// call itself can happen without holding the book.
#[derive(Debug, Clone)]
pub struct Context {
    pub accounts: Vec<String>,
    pub expense_categories: Vec<String>,
    pub income_categories: Vec<String>,
    pub merchants: Vec<String>,
    pub people: Option<String>,
    /// One line per recent posting, led by its id.
    pub recent: Vec<String>,
    pub today: String,
}

fn strings(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(sql).map_err(oops)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

pub fn context(conn: &Connection) -> Result<Context> {
    let accounts = strings(conn, "SELECT name FROM accounts WHERE archived = 0 ORDER BY sort_order")?;
    let categories = |kind: &str| {
        strings(
            conn,
            &format!(
                "SELECT CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' > ' || c.name END
                 FROM ({}) f JOIN categories c ON c.id = f.id
                 LEFT JOIN categories p ON p.id = c.parent_id
                 WHERE c.kind = '{kind}'
                 ORDER BY COALESCE(p.name, c.name), c.sort_order",
                capture::FILEABLE
            ),
        )
    };
    let recent = strings(
        conn,
        &format!(
            "SELECT t.id || ' · ' || substr(t.occurred_at, 1, 16) || ' · ' || t.kind || ' · ₹' ||
                    printf('%.2f', t.amount / 100.0) || ' · ' || COALESCE(a.name, '') || ' · ' || t.merchant
             FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
             ORDER BY t.occurred_at DESC LIMIT {RECENT}"
        ),
    )?;
    Ok(Context {
        accounts,
        expense_categories: categories("expense")?,
        income_categories: categories("income")?,
        merchants: capture::known_merchants(conn, Some(60))?,
        people: crate::db::setting(conn, capture::PEOPLE_SETTING)?.filter(|p| !p.trim().is_empty()),
        recent,
        today: chrono::Local::now().format("%Y-%m-%d %A %H:%M").to_string(),
    })
}

/// A picture to read, as it came off the phone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    /// image/png, image/jpeg, image/webp, image/gif or application/pdf.
    pub media_type: String,
    /// Base64, no data: prefix.
    pub data: String,
}

/// What Claude made of a capture.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Reading {
    pub is_transaction: bool,
    /// The capture in one line: the words themselves for text, what the
    /// picture shows for an image.
    pub said: String,
    pub kind: Option<String>,
    /// Rupees.
    pub amount: Option<f64>,
    pub account: Option<String>,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub merchant: Option<String>,
    /// YYYY-MM-DD.
    pub when: Option<String>,
    pub note: Option<String>,
    /// The id of a recent posting this is the same payment as.
    pub duplicate_of: Option<String>,
    pub sure: bool,
}

/// A string from `options`, or null; a free string when there are no options.
fn one_of(options: &[String]) -> Value {
    if options.is_empty() {
        json!({ "type": ["string", "null"] })
    } else {
        json!({ "anyOf": [{ "type": "string", "enum": options }, { "type": "null" }] })
    }
}

fn schema(ctx: &Context) -> Value {
    let mut categories = ctx.expense_categories.clone();
    categories.extend(ctx.income_categories.iter().cloned());
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["is_transaction", "said", "kind", "amount", "account", "to_account",
                     "category", "merchant", "when", "note", "duplicate_of", "sure"],
        "properties": {
            "is_transaction": { "type": "boolean" },
            "said": { "type": "string" },
            "kind": { "anyOf": [{ "type": "string", "enum": ["expense", "income", "transfer"] }, { "type": "null" }] },
            "amount": { "type": ["number", "null"] },
            "account": one_of(&ctx.accounts),
            "to_account": one_of(&ctx.accounts),
            "category": one_of(&categories),
            "merchant": { "type": ["string", "null"] },
            "when": { "type": ["string", "null"] },
            "note": { "type": ["string", "null"] },
            "duplicate_of": { "type": ["string", "null"] },
            "sure": { "type": "boolean" },
        }
    })
}

fn list(items: &[String]) -> String {
    if items.is_empty() {
        "(none)".into()
    } else {
        items.join("\n")
    }
}

/// The book, for the cacheable part of the prompt.
fn system_prompt(ctx: &Context) -> String {
    format!(
        "You read one capture for a personal expense book kept in Indian rupees and turn it \
into a transaction. A capture is a sentence someone typed or said, a bank or UPI SMS, or a \
screenshot of a payment, receipt or bank app.\n\n\
Rules:\n\
- is_transaction is false for anything that records no money moving: OTPs, balance alerts, \
offers, reminders, failed or declined payments. Fill the rest with nulls and sure = false.\n\
- said: for text, the words as given, trimmed. For an image, one short line in plain words \
saying what it shows, such as \"UPI payment of ₹450 to Swiggy\".\n\
- amount is in rupees, a plain number. Never guess one.\n\
- account and to_account must be one of the accounts listed, or null. Match card or account \
numbers in an SMS (\"A/c XX1234\", \"card ending 1234\") to the account whose name carries them. \
to_account is only for transfers.\n\
- category must be one listed for that kind, or null. Never file a transfer.\n\
- merchant: a clean counterparty name. Prefer the spelling in the known merchants list.\n\
- when: the date the money moved as YYYY-MM-DD, or null for today.\n\
- note: anything worth keeping that isn't the merchant, or null.\n\
- duplicate_of: the id of a recent posting that is the same payment (same amount, same \
counterparty or account, within a day or two), or null.\n\
- sure is true only when the amount, account and category are all clear from the capture \
and the book, with no guessing between options.\n\n\
Accounts:\n{}\n\nExpense categories:\n{}\n\nIncome categories:\n{}\n\nKnown merchants:\n{}\n\n\
People and how money with them is filed:\n{}",
        list(&ctx.accounts),
        list(&ctx.expense_categories),
        list(&ctx.income_categories),
        list(&ctx.merchants),
        ctx.people.as_deref().unwrap_or("(none)"),
    )
}

/// The request body. Split out so it can be checked without a network.
pub fn body(ctx: &Context, text: Option<&str>, image: Option<&Image>) -> Value {
    let mut content = Vec::new();
    if let Some(img) = image {
        let kind = if img.media_type == "application/pdf" { "document" } else { "image" };
        content.push(json!({
            "type": kind,
            "source": { "type": "base64", "media_type": img.media_type, "data": img.data },
        }));
    }
    content.push(json!({
        "type": "text",
        "text": format!(
            "Now: {}\n\nRecent postings (id · when · kind · amount · account · merchant):\n{}\n\nCapture:\n{}",
            ctx.today,
            list(&ctx.recent),
            text.filter(|t| !t.trim().is_empty()).unwrap_or("(the attached image)"),
        ),
    }));
    json!({
        "model": MODEL,
        "max_tokens": 1024,
        "output_config": {
            "effort": "low",
            "format": { "type": "json_schema", "schema": schema(ctx) },
        },
        "system": [{
            "type": "text",
            "text": system_prompt(ctx),
            // The book changes far less often than captures arrive.
            "cache_control": { "type": "ephemeral" },
        }],
        "messages": [{ "role": "user", "content": content }],
    })
}

/// Pulls the reading out of a Messages API response.
pub fn parse(response: &Value) -> Result<Reading> {
    let text = response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<String>();
    serde_json::from_str(text.trim()).map_err(|_| "Claude's reading couldn't be understood.".to_string())
}

/// Asks Claude to read one capture.
pub async fn read(ctx: &Context, text: Option<&str>, image: Option<&Image>) -> Result<Reading> {
    let cred = tauri::async_runtime::spawn_blocking(ai::credential)
        .await
        .map_err(|e| e.to_string())??;
    let client = ai::client(TIMEOUT)?;
    let resp = ai::request(&client, reqwest::Method::POST, "/v1/messages", &cred, &[])
        .json(&body(ctx, text, image))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
    if !resp.status().is_success() {
        return Err(ai::api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    parse(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context {
            accounts: vec!["HDFC".into(), "Cash".into()],
            expense_categories: vec!["Food > Delivery".into()],
            income_categories: vec![],
            merchants: vec!["Swiggy".into()],
            people: None,
            recent: vec![],
            today: "2026-11-28 Saturday 15:00".into(),
        }
    }

    #[test]
    fn the_request_names_only_this_books_accounts_and_categories() {
        let b = body(&ctx(), Some("450 swiggy hdfc"), None);
        let props = &b["output_config"]["format"]["schema"]["properties"];
        assert_eq!(props["account"]["anyOf"][0]["enum"], json!(["HDFC", "Cash"]));
        assert_eq!(props["category"]["anyOf"][0]["enum"], json!(["Food > Delivery"]));
        assert_eq!(b["model"], MODEL);
        let text = b["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(text.ends_with("450 swiggy hdfc"));
    }

    #[test]
    fn an_image_goes_first_and_a_pdf_as_a_document() {
        let img = Image { media_type: "application/pdf".into(), data: "AAAA".into() };
        let b = body(&ctx(), None, Some(&img));
        assert_eq!(b["messages"][0]["content"][0]["type"], "document");
        assert_eq!(b["messages"][0]["content"][1]["type"], "text");
    }

    #[test]
    fn a_reading_is_read_out_of_the_response() {
        let r = parse(&json!({ "content": [{ "type": "text", "text": "{\"is_transaction\":true,\"said\":\"450 swiggy\",\"kind\":\"expense\",\"amount\":450,\"account\":\"HDFC\",\"to_account\":null,\"category\":\"Food > Delivery\",\"merchant\":\"Swiggy\",\"when\":null,\"note\":null,\"duplicate_of\":null,\"sure\":true}" }] }))
            .unwrap();
        assert_eq!(r.amount, Some(450.0));
        assert!(r.sure && r.is_transaction);
        assert!(parse(&json!({ "content": [] })).is_err());
    }
}
