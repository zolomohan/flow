//! Reading statements with Claude.
//!
//! A statement arrives in whatever shape the bank chose — a PDF, a CSV, the
//! legacy .xls HDFC still hands out, a screenshot — and leaves as the same
//! `StatementRow`s the spreadsheet importer produces, each carrying Claude's
//! guess at how it should be filed. From there it is the importer's business:
//! the same duplicate check, the same remembered rules, the same commit.
//!
//! Nothing here touches the book. The caller hands in the categories and
//! accounts to choose from, and gets suggestions back.
//!
//! Credentials come from one of three places, tried in this order:
//!
//! 1. **The Anthropic CLI's sign-in** (`ant auth login`). Flow never sees a
//!    long-lived secret: it asks `ant` for a short-lived access token each
//!    time it reads, and `ant` refreshes it as needed.
//! 2. **An API key in the macOS Keychain**, pasted once in Settings.
//! 3. **`ANTHROPIC_API_KEY` in the environment** — only ever there in
//!    development, since an app opened from Finder inherits no shell.
//!
//! Anthropic has no "Sign in with Claude" for a local app like this one: its
//! OAuth for third-party apps needs a server and an identity provider, and a
//! claude.ai subscription can't be used by other apps at all. Borrowing the
//! CLI's sign-in is the nearest thing that is allowed.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::models::{Account, Category, Paise, StatementRow};

type Result<T> = std::result::Result<T, String>;

pub(crate) const API: &str = "https://api.anthropic.com";
pub(crate) const API_VERSION: &str = "2026-10-21";
pub(crate) const MODEL: &str = "claude-opus-5-5";
/// Sent with a CLI sign-in's token, which is OAuth rather than a key.
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Lets the API re-run a declined request on another model inside the same
/// call, instead of handing the refusal back.
pub(crate) const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

const KEYCHAIN_SERVICE: &str = "flow.claude";
const KEYCHAIN_ACCOUNT: &str = "api-key";

/// The request limit is 32 MB once base64 has added its third.
const MAX_FILE_BYTES: u64 = 22 * 1024 * 1024;

// ------------------------------------------------------------ credentials

#[derive(Debug, Clone)]
pub(crate) enum Credential {
    /// A short-lived OAuth access token from the CLI's sign-in.
    Bearer(String),
    ApiKey(String),
}

/// Where Flow would get its credential from right now, and what else is
/// there — Settings shows all of it so nothing about the connection is a
/// guess.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// ant | keychain | env — or nothing, when Claude can't be reached.
    pub source: Option<String>,
    /// Where the `ant` binary was found, if it was.
    pub ant_path: Option<String>,
    pub ant_signed_in: bool,
    /// Why the sign-in didn't produce a token, when `ant` is installed.
    pub ant_problem: Option<String>,
    pub has_key: bool,
    pub has_env_key: bool,
    pub model: String,
}

/// The `ant` binary. An app opened from Finder runs with a bare PATH, so the
/// places Homebrew and `go install` put it are looked in by name as well.
fn find_ant() -> Option<String> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for fixed in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(fixed.into());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        dirs.push(home.join("go/bin"));
        dirs.push(home.join(".local/bin"));
    }
    dirs.into_iter()
        .map(|d| d.join("ant"))
        .find(|p| p.is_file() && is_anthropic_cli(p))
        .map(|p| p.to_string_lossy().into_owned())
}

/// Apache Ant, the Java build tool, also installs a binary called `ant`.
/// Anthropic's knows the `auth` subcommand; Apache's would go looking for a
/// build.xml.
fn is_anthropic_cli(path: &Path) -> bool {
    Command::new(path)
        .args(["auth", "--help"])
        .output()
        .map(|o| {
            let said = [o.stdout, o.stderr].concat();
            String::from_utf8_lossy(&said).contains("login")
        })
        .unwrap_or(false)
}

/// A fresh access token from the CLI's active profile. `print-credentials`
/// refreshes the token itself when it has run out.
fn ant_token(ant: &str) -> Result<String> {
    let out = Command::new(ant)
        .args(["auth", "print-credentials", "--access-token"])
        // A key in the environment would shadow the sign-in for `ant`'s
        // other commands; this one always reads the profile, but there is
        // no reason to hand it one.
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .output()
        .map_err(|e| format!("Couldn't run ant: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        return Err(if first.is_empty() {
            "Not signed in. Run `ant auth login` in Terminal.".into()
        } else {
            format!("{first} — run `ant auth login` in Terminal to sign in again.")
        });
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // The flagless form prints JSON; a token is one unbroken word.
    if token.is_empty() || token.contains(char::is_whitespace) || token.starts_with('{') {
        return Err("ant didn't hand back a token. Run `ant auth login` in Terminal.".into());
    }
    Ok(token)
}

fn keychain_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn keychain_key() -> Option<String> {
    keychain_entry()
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty())
}

fn env_key() -> Option<String> {
    std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.trim().is_empty())
}

pub fn save_key(key: &str) -> Result<()> {
    let key = key.trim();
    if !key.starts_with("sk-ant-") {
        return Err("That doesn't look like an Anthropic API key — they start with sk-ant-.".into());
    }
    keychain_entry()?
        .set_password(key)
        .map_err(|e| format!("The Keychain refused the key: {e}"))
}

pub fn forget_key() -> Result<()> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Every source, looked at. Asking `ant` for a token is how "signed in" is
/// known — there is no cheaper question that is also a true one.
pub fn status() -> AiStatus {
    let ant_path = find_ant();
    let (ant_signed_in, ant_problem) = match ant_path.as_deref().map(ant_token) {
        Some(Ok(_)) => (true, None),
        Some(Err(e)) => (false, Some(e)),
        None => (false, None),
    };
    let has_key = keychain_key().is_some();
    let has_env_key = env_key().is_some();
    let source = if ant_signed_in {
        Some("ant")
    } else if has_key {
        Some("keychain")
    } else if has_env_key {
        Some("env")
    } else {
        None
    };
    AiStatus {
        source: source.map(String::from),
        ant_path,
        ant_signed_in,
        ant_problem,
        has_key,
        has_env_key,
        model: MODEL.into(),
    }
}

pub(crate) fn credential() -> Result<Credential> {
    let mut ant_problem = None;
    if let Some(ant) = find_ant() {
        match ant_token(&ant) {
            Ok(token) => return Ok(Credential::Bearer(token)),
            Err(e) => ant_problem = Some(e),
        }
    }
    if let Some(key) = keychain_key().or_else(env_key) {
        return Ok(Credential::ApiKey(key));
    }
    Err(ant_problem.unwrap_or_else(|| {
        "Claude isn't connected yet. Sign in or add an API key in Settings → Claude.".into()
    }))
}

pub(crate) fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    cred: &Credential,
    betas: &[&str],
) -> reqwest::RequestBuilder {
    let mut betas: Vec<&str> = betas.to_vec();
    let builder = client
        .request(method, format!("{API}{path}"))
        .header("anthropic-version", API_VERSION);
    let builder = match cred {
        Credential::Bearer(token) => {
            betas.push(OAUTH_BETA);
            builder.bearer_auth(token)
        }
        Credential::ApiKey(key) => builder.header("x-api-key", key),
    };
    if betas.is_empty() {
        builder
    } else {
        builder.header("anthropic-beta", betas.join(","))
    }
}

/// The API's own words for a failed request, put the way a person reading a
/// Settings page would want them.
pub(crate) async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 => format!("Claude didn't accept the credentials ({message}). Sign in again or check the key in Settings → Claude."),
        403 => format!("This account isn't allowed to do that: {message}"),
        429 => format!("Claude is rate-limiting this account — wait a minute and try again. ({message})"),
        529 | 503 => "Claude is overloaded right now. Try again in a minute.".into(),
        _ => format!("Claude returned {status}: {message}"),
    }
}

pub(crate) fn client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// Checks the credential against the API without spending anything: the
/// model list is free.
pub async fn test() -> Result<String> {
    let cred = tauri::async_runtime::spawn_blocking(credential)
        .await
        .map_err(|e| e.to_string())??;
    let client = client(Duration::from_secs(30))?;
    let resp = request(&client, reqwest::Method::GET, &format!("/v1/models/{MODEL}"), &cred, &[])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["display_name"].as_str().unwrap_or(MODEL).to_string())
}

// --------------------------------------------------------------- reading

/// One transaction Claude found, in the importer's terms plus its guess.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRow {
    pub row: StatementRow,
    /// expense | income | transfer
    pub kind: String,
    pub category_id: Option<String>,
    pub transfer_account_id: Option<String>,
    /// A clean merchant or counterparty name.
    pub description: String,
    pub note: String,
    /// high | medium | low
    pub confidence: String,
    /// The file it was read from.
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    run: &'a str,
    file: &'a str,
    file_index: usize,
    file_count: usize,
    /// sending | reading | done
    phase: &'a str,
    found: usize,
}

/// Reads each file in turn and answers with every transaction dated inside
/// the range. Progress goes out as `ai-read-progress` events tagged with
/// `run`, so a wizard that was closed and reopened ignores an old run.
#[allow(clippy::too_many_arguments)]
pub async fn read_statements(
    app: AppHandle,
    run: String,
    paths: Vec<String>,
    account: Account,
    from: String,
    to: String,
    categories: Vec<Category>,
    accounts: Vec<Account>,
) -> Result<Vec<AiRow>> {
    if paths.is_empty() {
        return Err("Pick at least one statement.".into());
    }
    let cred = tauri::async_runtime::spawn_blocking(credential)
        .await
        .map_err(|e| e.to_string())??;
    // Long statements are long to write out; the stream keeps the
    // connection busy, so the ceiling is only there to end a wedged one.
    let client = client(Duration::from_secs(20 * 60))?;
    let system = system_prompt(&account, &categories, &accounts);
    let schema = output_schema(&categories, &accounts, &account.id);

    let mut out = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let emit = |phase: &str, found: usize| {
            let _ = app.emit(
                "ai-read-progress",
                Progress {
                    run: &run,
                    file: &name,
                    file_index: i,
                    file_count: paths.len(),
                    phase,
                    found,
                },
            );
        };
        emit("sending", 0);
        let content = file_content(path, &name)?;
        let user = vec![
            content,
            json!({
                "type": "text",
                "text": format!(
                    "This is a statement for the account \"{}\". List every transaction \
                     dated from {from} to {to}, both days included. Leave out anything \
                     outside those dates.",
                    account.name
                ),
            }),
        ];
        let body = json!({
            "model": MODEL,
            "max_tokens": 64000,
            "stream": true,
            "fallbacks": "default",
            "thinking": { "type": "adaptive" },
            "output_config": {
                "effort": "medium",
                "format": { "type": "json_schema", "schema": schema },
            },
            "system": [{
                "type": "text",
                "text": system,
                // The same instructions and category list go out with every
                // file of a run; caching them makes the second file cheaper.
                "cache_control": { "type": "ephemeral" },
            }],
            "messages": [{ "role": "user", "content": user }],
        });
        let text = stream_text(&client, &cred, &body, |found| emit("reading", found))
            .await
            .map_err(|e| format!("{name}: {e}"))?;
        let rows = rows_from(&text, &name, &account, &from, &to, &categories, &accounts)
            .map_err(|e| format!("{name}: {e}"))?;
        emit("done", rows.len());
        out.extend(rows);
    }
    Ok(out)
}

/// One file as a content block Claude can read. PDFs and pictures go as
/// themselves; spreadsheets are flattened to CSV, since that is all Claude
/// would make of them anyway; anything else is read as text.
fn file_content(path: &str, name: &str) -> Result<Value> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{name}: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{name} is {} MB — too big to send in one go. Split it into shorter statements.",
            meta.len() / (1024 * 1024)
        ));
    }
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    match ext.as_str() {
        "pdf" => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name}: {e}"))?;
            if pdf_is_encrypted(&bytes) {
                return Err(format!(
                    "{name} is password-protected, which Claude can't open. Open it in \
                     Preview, choose File → Export as PDF, and leave the password off."
                ));
            }
            Ok(json!({
                "type": "document",
                "source": { "type": "base64", "media_type": "application/pdf", "data": b64(&bytes) },
                "title": name,
            }))
        }
        "png" | "jpg" | "jpeg" | "webp" | "gif" => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name}: {e}"))?;
            let media = match ext.as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                "gif" => "image/gif",
                _ => "image/jpeg",
            };
            Ok(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media, "data": b64(&bytes) },
            }))
        }
        "xls" | "xlsx" | "xlsm" | "ods" => Ok(text_block(name, &spreadsheet_csv(path)?)),
        _ => {
            let bytes = std::fs::read(path).map_err(|e| format!("{name}: {e}"))?;
            let text = String::from_utf8_lossy(&bytes);
            if text.trim().is_empty() {
                return Err(format!("{name} is empty."));
            }
            Ok(text_block(name, &text))
        }
    }
}

fn text_block(name: &str, text: &str) -> Value {
    json!({
        "type": "document",
        "source": { "type": "text", "media_type": "text/plain", "data": text },
        "title": name,
    })
}

/// A PDF that needs a password says so in its trailer with an /Encrypt entry.
fn pdf_is_encrypted(bytes: &[u8]) -> bool {
    bytes.windows(8).any(|w| w == b"/Encrypt")
}

/// Every sheet of a workbook as CSV, one after another.
fn spreadsheet_csv(path: &str) -> Result<String> {
    let mut book = open_workbook_auto(path)
        .map_err(|e| format!("That file could not be read as a spreadsheet: {e}"))?;
    let mut out = String::new();
    for name in book.sheet_names().to_vec() {
        let Ok(range) = book.worksheet_range(&name) else { continue };
        out.push_str(&format!("# Sheet: {name}\n"));
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(csv_cell).collect();
            if cells.iter().all(|c| c.is_empty()) {
                continue;
            }
            out.push_str(&cells.join(","));
            out.push('\n');
        }
    }
    if out.trim().is_empty() {
        return Err("The spreadsheet has nothing in it.".into());
    }
    Ok(out)
}

fn csv_cell(cell: &Data) -> String {
    let text = match cell {
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        // A date cell is a day count from Excel's epoch, 1899-12-30.
        Data::DateTime(d) => chrono::NaiveDate::from_ymd_opt(1899, 12, 30)
            .and_then(|epoch| epoch.checked_add_days(chrono::Days::new(d.as_f64() as u64)))
            .map(|day| day.to_string())
            .unwrap_or_else(|| d.to_string()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        _ => String::new(),
    };
    if text.contains([',', '"', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

fn system_prompt(account: &Account, categories: &[Category], accounts: &[Account]) -> String {
    let card = account.kind == "credit";
    let mut cats = String::new();
    let parent_name = |id: &str| {
        categories
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.name.clone())
            .unwrap_or_default()
    };
    for c in categories {
        let path = match c.parent_id.as_deref() {
            Some(p) => format!("{} › {}", parent_name(p), c.name),
            None => c.name.clone(),
        };
        cats.push_str(&format!("- {} | {} | {}\n", c.id, c.kind, path));
    }
    let mut accts = String::new();
    for a in accounts.iter().filter(|a| a.id != account.id) {
        accts.push_str(&format!(
            "- {} | {} | {}{}\n",
            a.id,
            a.kind,
            a.name,
            a.institution.as_deref().map(|i| format!(" ({i})")).unwrap_or_default()
        ));
    }
    let direction = if card {
        "This is a credit card. A purchase, fee, interest or cash withdrawal on the card is a \
         debit (money spent). A payment towards the card, a refund or a cashback is a credit."
    } else {
        "A withdrawal, payment or charge is a debit (money left the account). A deposit, \
         salary, refund or interest is a credit (money arrived)."
    };
    format!(
        "You read bank and credit card statements for a personal finance app in India and \
turn every transaction into structured data. Amounts are in Indian rupees.

For each transaction:
- date: the transaction date (not the value date), as YYYY-MM-DD. Indian statements write \
dates day first.
- narration: the bank's own description of the line, copied exactly as printed, including \
UPI IDs and reference numbers. The app keys its memory of each counterparty on this text, \
so do not tidy it.
- amount: the amount in rupees as a positive number. If a card line was billed in another \
currency, use the rupee amount that was charged.
- direction: debit or credit. {direction}
- balance: the running balance printed beside the line, or null if there isn't one.
- kind: expense for money spent, income for money received, transfer when the money moved \
between this account and another of the user's own accounts listed below (a credit card bill \
paid from a bank account, a top-up of a wallet, a sweep into a deposit).
- transfer_account_id: for a transfer, the id of the other account; otherwise null.
- description: a short, clean name for the merchant or counterparty, in title case, as a \
person would write it (\"Swiggy\", \"Uber\", \"Rent to Anil\"). No reference numbers.
- category_id: the best category from the list below, whose kind must match: expense \
categories for debits, income categories for credits. Prefer the most specific \
sub-category that fits. Use null for transfers, and when nothing fits.
- note: a few words on what the transaction probably was, when the narration gives a clue \
beyond the merchant (\"Monthly Netflix subscription\", \"Refund for cancelled order\"). Use \
an empty string when there is nothing to add.
- confidence: high when the category is obvious from the merchant, medium when it is a \
reasonable guess, low when you could not tell.

Include every transaction line in the requested dates, including fees, interest, charges \
and reversals. Leave out opening and closing balances, totals, summaries, reward points and \
anything that is not a single transaction. If the same line appears twice because the \
statement repeats it on a page break, include it once.

Categories (id | kind | name):
{cats}
The user's other accounts (id | type | name):
{accts}"
    )
}

/// The shape Claude must answer in. Category and account ids are spelled out
/// as enums, so an answer can only ever name ones that exist.
fn output_schema(categories: &[Category], accounts: &[Account], self_id: &str) -> Value {
    let id_or_null = |ids: Vec<&str>| {
        if ids.is_empty() {
            json!({ "type": "null" })
        } else {
            json!({ "anyOf": [{ "type": "string", "enum": ids }, { "type": "null" }] })
        }
    };
    let category_ids: Vec<&str> = categories.iter().map(|c| c.id.as_str()).collect();
    let account_ids: Vec<&str> = accounts
        .iter()
        .filter(|a| a.id != self_id)
        .map(|a| a.id.as_str())
        .collect();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["transactions"],
        "properties": {
            "transactions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "date", "narration", "amount", "direction", "balance", "kind",
                        "transfer_account_id", "description", "category_id", "note",
                        "confidence"
                    ],
                    "properties": {
                        "date": { "type": "string", "format": "date" },
                        "narration": { "type": "string" },
                        "amount": { "type": "number" },
                        "direction": { "type": "string", "enum": ["debit", "credit"] },
                        "balance": { "anyOf": [{ "type": "number" }, { "type": "null" }] },
                        "kind": { "type": "string", "enum": ["expense", "income", "transfer"] },
                        "transfer_account_id": id_or_null(account_ids),
                        "description": { "type": "string" },
                        "category_id": id_or_null(category_ids),
                        "note": { "type": "string" },
                        "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
                    },
                },
            },
        },
    })
}

/// Sends one streaming request and gathers the text it writes. `on_found` is
/// told how many transactions have been written so far, which is what the
/// wizard's progress shows.
async fn stream_text(
    client: &reqwest::Client,
    cred: &Credential,
    body: &Value,
    on_found: impl Fn(usize),
) -> Result<String> {
    let send = |body: &Value, betas: &[&str]| {
        request(client, reqwest::Method::POST, "/v1/messages", cred, betas)
            .json(body)
            .send()
    };
    let mut resp = send(body, &[FALLBACK_BETA])
        .await
        .map_err(|e| format!("Couldn't reach Claude: {e}"))?;
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        // Server-side fallbacks are a beta; if this account or credential
        // can't have them, read without rather than not at all.
        let err = api_error(resp).await;
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
        return Err(api_error(resp).await);
    }

    let mut parser = SseText::default();
    let mut buf: Vec<u8> = Vec::new();
    let mut last_found = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The connection dropped: {e}"))? {
        buf.extend_from_slice(&chunk);
        // Events end with a blank line; anything after the last one waits
        // for the next chunk.
        while let Some(end) = find_event_end(&buf) {
            let event: Vec<u8> = buf.drain(..end.1).collect();
            let event = String::from_utf8_lossy(&event[..end.0]);
            parser.feed(&event)?;
        }
        let found = parser.text().matches("\"narration\"").count();
        if found != last_found {
            last_found = found;
            on_found(found);
        }
    }
    parser.finish()
}

/// Where the first complete event in `buf` ends: (end of its text, end of
/// its terminating blank line).
pub(crate) fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|i| (i, i + 2));
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, i + 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// The text blocks of a streamed message, in order, and how it stopped.
#[derive(Default)]
struct SseText {
    /// (block type, text) by content-block index.
    blocks: Vec<(String, String)>,
    stop_reason: Option<String>,
}

impl SseText {
    fn feed(&mut self, event: &str) -> Result<()> {
        let data: String = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(());
        }
        let v: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        match v["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let i = v["index"].as_u64().unwrap_or(0) as usize;
                if self.blocks.len() <= i {
                    self.blocks.resize(i + 1, (String::new(), String::new()));
                }
                self.blocks[i].0 = v["content_block"]["type"].as_str().unwrap_or("").into();
            }
            "content_block_delta" if v["delta"]["type"] == "text_delta" => {
                let i = v["index"].as_u64().unwrap_or(0) as usize;
                if self.blocks.len() <= i {
                    self.blocks.resize(i + 1, ("text".into(), String::new()));
                }
                self.blocks[i].1.push_str(v["delta"]["text"].as_str().unwrap_or(""));
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
        Ok(())
    }

    fn text(&self) -> String {
        self.blocks
            .iter()
            .filter(|(kind, _)| kind == "text")
            .map(|(_, t)| t.as_str())
            .collect()
    }

    fn finish(self) -> Result<String> {
        match self.stop_reason.as_deref() {
            Some("refusal") => Err(
                "Claude declined to read this statement. Try again, or import it as a spreadsheet."
                    .into(),
            ),
            Some("max_tokens") => Err(
                "The statement has more transactions than Claude can write out in one go. \
                 Pick a shorter date range and read it in parts."
                    .into(),
            ),
            _ => Ok(self.text()),
        }
    }
}

#[derive(Deserialize)]
struct Answer {
    transactions: Vec<Found>,
}

#[derive(Deserialize)]
struct Found {
    date: String,
    narration: String,
    amount: f64,
    direction: String,
    balance: Option<f64>,
    kind: String,
    transfer_account_id: Option<String>,
    description: String,
    category_id: Option<String>,
    note: String,
    confidence: String,
}

/// Claude's answer, checked against the book: dates that parse and fall in
/// the range, categories of the right kind, transfers to an account that
/// isn't this one. What fails a check is corrected to the plain reading
/// rather than thrown away — the row is still a real line on the statement.
fn rows_from(
    text: &str,
    file: &str,
    account: &Account,
    from: &str,
    to: &str,
    categories: &[Category],
    accounts: &[Account],
) -> Result<Vec<AiRow>> {
    let answer: Answer = parse_answer(text)?;
    let paise = |rupees: f64| (rupees.abs() * 100.0).round() as Paise;
    let mut out = Vec::new();
    for f in answer.transactions {
        let Ok(day) = chrono::NaiveDate::parse_from_str(f.date.trim(), "%Y-%m-%d") else {
            continue;
        };
        let date = day.to_string();
        if date.as_str() < from || date.as_str() > to {
            continue;
        }
        let amount = paise(f.amount);
        if amount == 0 {
            continue;
        }
        let direction = if f.direction == "credit" { "credit" } else { "debit" };
        let plain = if direction == "debit" { "expense" } else { "income" };

        let transfer_to = f
            .transfer_account_id
            .filter(|id| id != &account.id && accounts.iter().any(|a| &a.id == id));
        let (kind, transfer_account_id) = match (f.kind.as_str(), transfer_to) {
            ("transfer", Some(other)) => ("transfer", Some(other)),
            _ => (plain, None),
        };
        let category_id = if kind == "transfer" {
            None
        } else {
            f.category_id
                .filter(|id| categories.iter().any(|c| &c.id == id && c.kind == kind))
        };
        let narration = f.narration.trim().to_string();
        let description = match f.description.trim() {
            "" => crate::import::display_merchant(&narration),
            d => d.to_string(),
        };
        let confidence = match f.confidence.as_str() {
            "high" | "medium" | "low" => f.confidence,
            _ => "low".into(),
        };
        out.push(AiRow {
            row: StatementRow {
                date,
                narration,
                ref_no: String::new(),
                amount,
                direction: direction.into(),
                balance: f.balance.map(|b| (b * 100.0).round() as Paise),
            },
            kind: kind.into(),
            category_id,
            transfer_account_id,
            description,
            note: f.note.trim().to_string(),
            confidence,
            file: file.into(),
        });
    }
    Ok(out)
}

/// The JSON Claude wrote. A mid-answer fallback continues the same text on
/// another model, so the whole thing normally parses as one; failing that,
/// the last complete object in it is taken.
fn parse_answer(text: &str) -> Result<Answer> {
    if let Ok(a) = serde_json::from_str::<Answer>(text.trim()) {
        return Ok(a);
    }
    if let Some(start) = text.rfind("{\"transactions\"") {
        if let Ok(a) = serde_json::from_str::<Answer>(text[start..].trim()) {
            return Ok(a);
        }
    }
    Err("Claude's answer couldn't be read. Try again.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, kind: &str) -> Account {
        serde_json::from_value(json!({
            "id": id, "name": id, "kind": kind, "institution": null,
            "openingBalance": 0, "color": "", "icon": "", "archived": false,
            "sortOrder": 0, "createdAt": "2026-01-01", "creditLimit": 0,
            "statementDay": 0, "dueDay": 0, "balance": 0, "revaluation": 0,
            "system": false,
        }))
        .unwrap_or_else(|e| panic!("account fixture: {e}"))
    }

    fn category(id: &str, kind: &str) -> Category {
        Category {
            id: id.into(),
            kind: kind.into(),
            name: id.into(),
            icon: String::new(),
            color: String::new(),
            sort_order: 0,
            parent_id: None,
        }
    }

    #[test]
    fn events_split_on_blank_lines() {
        let mut p = SseText::default();
        let stream = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n\
event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"{\\\"transactions\\\":\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"[]}\"}}\n\n\
event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n";
        let mut buf = stream.as_bytes().to_vec();
        while let Some(end) = find_event_end(&buf) {
            let event: Vec<u8> = buf.drain(..end.1).collect();
            p.feed(&String::from_utf8_lossy(&event[..end.0])).unwrap();
        }
        assert_eq!(p.finish().unwrap(), "{\"transactions\":[]}");
    }

    #[test]
    fn a_refusal_is_an_error() {
        let mut p = SseText::default();
        p.feed("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}")
            .unwrap();
        assert!(p.finish().is_err());
    }

    #[test]
    fn answers_are_checked_against_the_book() {
        let bank = account("bank", "bank");
        let card = account("card", "credit");
        let cats = vec![category("food", "expense"), category("salary", "income")];
        let text = json!({ "transactions": [
            // In range, well filed.
            { "date": "2026-10-03", "narration": "UPI-SWIGGY-swiggy@icici", "amount": 412.5,
              "direction": "debit", "balance": null, "kind": "expense",
              "transfer_account_id": null, "description": "Swiggy", "category_id": "food",
              "note": "", "confidence": "high" },
            // Out of range: dropped.
            { "date": "2026-09-30", "narration": "x", "amount": 1.0, "direction": "debit",
              "balance": null, "kind": "expense", "transfer_account_id": null,
              "description": "X", "category_id": null, "note": "", "confidence": "low" },
            // An income category on a debit: the category goes.
            { "date": "2026-10-04", "narration": "POS 1234 STORE", "amount": -99.0,
              "direction": "debit", "balance": 1000.0, "kind": "expense",
              "transfer_account_id": null, "description": "", "category_id": "salary",
              "note": "", "confidence": "medium" },
            // A transfer to itself: read as plain income.
            { "date": "2026-10-05", "narration": "NEFT-SELF", "amount": 5000.0,
              "direction": "credit", "balance": null, "kind": "transfer",
              "transfer_account_id": "bank", "description": "Self", "category_id": null,
              "note": "", "confidence": "high" },
            // A card bill: a real transfer.
            { "date": "2026-10-06", "narration": "CC PAYMENT", "amount": 20000.0,
              "direction": "debit", "balance": null, "kind": "transfer",
              "transfer_account_id": "card", "description": "Card bill", "category_id": "food",
              "note": "", "confidence": "high" },
        ]})
        .to_string();
        let rows = rows_from(
            &text, "s.pdf", &bank, "2026-10-01", "2026-10-31", &cats,
            &[bank.clone(), card.clone()],
        )
        .unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].row.amount, 41250);
        assert_eq!(rows[0].category_id.as_deref(), Some("food"));
        assert_eq!(rows[1].row.amount, 9900);
        assert_eq!(rows[1].category_id, None);
        assert_eq!(rows[1].description, "Store");
        assert_eq!(rows[1].row.balance, Some(100000));
        assert_eq!(rows[2].kind, "income");
        assert_eq!(rows[2].transfer_account_id, None);
        assert_eq!(rows[3].kind, "transfer");
        assert_eq!(rows[3].transfer_account_id.as_deref(), Some("card"));
        assert_eq!(rows[3].category_id, None);
    }

    #[test]
    fn locked_pdfs_are_caught_before_sending() {
        assert!(pdf_is_encrypted(b"%PDF-1.7 ... trailer << /Encrypt 12 0 R >>"));
        assert!(!pdf_is_encrypted(b"%PDF-1.7 ... trailer << /Root 1 0 R >>"));
    }
}
