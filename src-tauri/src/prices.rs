//! Live prices for the Investments screen.
//!
//! Nothing here touches the database: `fetch` goes to the network and hands
//! back quotes, and `db::store_prices` puts them away. Everything downstream
//! values a book off that cache, so holdings are worth the same offline as on
//! — the app just says how old the last price is.

use chrono::NaiveDate;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::db::{Result, KEY_FX, KEY_GOLD};
use crate::models::{Scaled, Scheme};

/// One instrument's price, ready for the cache.
pub struct Quote {
    pub key: String,
    pub price_e4: Scaled,
    /// The date this price is good for (YYYY-MM-DD).
    pub as_of: String,
    pub source: String,
}

/// A run of daily prices for one instrument, oldest first — what a chart is
/// drawn from, as against the single `Quote` a holding is valued at.
pub struct Series {
    pub key: String,
    pub points: Vec<(String, Scaled)>,
}

/// What one refresh came back with: today's prices, and any history that was
/// fetched alongside them.
#[derive(Default)]
pub struct Fetched {
    pub quotes: Vec<Quote>,
    pub history: Vec<Series>,
}

const TIMEOUT: Duration = Duration::from_secs(10);
/// Search happens while someone is typing, so it gets far less patience than a
/// background price refresh does.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(4);
/// How long mfapi is left alone after it fails to answer. Without this, every
/// keystroke would sit through the timeout again before falling back.
const MFAPI_COOLDOWN: Duration = Duration::from_secs(5 * 60);
static MFAPI_DOWN_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

fn mfapi_is_resting() -> bool {
    match MFAPI_DOWN_UNTIL.lock() {
        Ok(guard) => guard.is_some_and(|until| Instant::now() < until),
        Err(_) => false,
    }
}

fn rest_mfapi() {
    if let Ok(mut guard) = MFAPI_DOWN_UNTIL.lock() {
        *guard = Some(Instant::now() + MFAPI_COOLDOWN);
    }
}

/// International spot gold in dollars an ounce. Keyless.
const GOLD_URL: &str = "https://api.gold-api.com/price/XAU";
/// The ECB's daily reference rate, by way of Frankfurter. Keyless.
const FX_URL: &str = "https://api.frankfurter.dev/v1/latest";
/// AMFI's published NAVs, wrapped as JSON one scheme at a time.
const MFAPI_URL: &str = "https://api.mfapi.in/mf";
/// Every scheme AMFI publishes, in one semicolon-delimited file. The fallback
/// when mfapi is unreachable, and what scheme search reads.
const AMFI_URL: &str = "https://portal.amfiindia.com/spages/NAVAll.txt";
/// The LBMA's daily gold price in dollars an ounce, published back to 1968.
/// Keyless, and the benchmark the trade itself settles against — the live
/// spot quote above is what today is worth, this is what every day before it
/// was worth.
const LBMA_URL: &str = "https://prices.lbma.org.uk/json/gold_pm.json";
/// Frankfurter serves a date range of ECB rates in a single request.
const FX_RANGE_URL: &str = "https://api.frankfurter.dev/v1";

/// How far back a backfill reaches. Ten years outruns every range the charts
/// offer and still costs one request per source, once.
const HISTORY_YEARS: i64 = 10;

/// reqwest's own message stops at "error sending request for url (…)", which
/// says nothing about why. The cause underneath is the part worth reading.
fn why(e: impl std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = e.source();
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.join(" — ")
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("midas/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(why)
}

/// Reads a plain decimal into a 10^4-scaled integer without going through a
/// float. Prices arrive as text and stay exact the whole way in, which is the
/// same bargain `Paise` strikes for money.
fn decimal_to_e4(text: &str) -> Option<Scaled> {
    let text = text.trim();
    let (sign, text) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text),
    };
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty() && frac.is_empty() {
        return None;
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let whole: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    // Four digits are kept; a fifth only decides whether the fourth rounds up.
    let digit = |i: usize| frac.as_bytes().get(i).map_or(0, |b| (b - b'0') as i64);
    let mut scaled = digit(0) * 1000 + digit(1) * 100 + digit(2) * 10 + digit(3);
    if digit(4) >= 5 {
        scaled += 1;
    }
    Some(sign * (whole * 10_000 + scaled))
}

/// AMFI writes `28-Aug-2026` and mfapi writes `28-08-2026`; the cache keeps
/// `2026-08-28` so dates sort as strings like every other date in the book.
fn to_iso_date(text: &str) -> Option<String> {
    let text = text.trim();
    for fmt in ["%d-%m-%Y", "%d-%b-%Y", "%Y-%m-%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(text, fmt) {
            return Some(d.format("%Y-%m-%d").to_string());
        }
    }
    // gold-api stamps an RFC3339 instant; the day is all this needs.
    text.get(..10)
        .filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
        .map(str::to_string)
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

async fn text_of(client: &reqwest::Client, url: &str) -> Result<String> {
    let response = client.get(url).send().await.map_err(why)?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    response.text().await.map_err(why)
}

async fn json_of<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T> {
    serde_json::from_str(&text_of(client, url).await?).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct GoldResponse {
    price: serde_json::Number,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct FxResponse {
    date: String,
    rates: HashMap<String, serde_json::Number>,
}

#[derive(Deserialize)]
struct LbmaPoint {
    d: String,
    /// `[USD, GBP, EUR]` for the day. Only the dollar price is wanted, and it
    /// is null on days the fix didn't run.
    v: Vec<Option<serde_json::Number>>,
}

#[derive(Deserialize)]
struct FxRangeResponse {
    rates: HashMap<String, HashMap<String, serde_json::Number>>,
}

#[derive(Deserialize)]
struct NavResponse {
    data: Vec<NavPoint>,
}

#[derive(Deserialize)]
struct NavPoint {
    date: String,
    nav: String,
}

#[derive(Deserialize)]
struct SchemeHit {
    #[serde(rename = "schemeCode")]
    scheme_code: serde_json::Number,
    #[serde(rename = "schemeName")]
    scheme_name: String,
}

/// Spot gold and the rupee, which are only useful together — a dollar price
/// with no exchange rate values nothing.
async fn gold(client: &reqwest::Client) -> Result<Vec<Quote>> {
    let metal: GoldResponse = json_of(client, GOLD_URL).await?;
    let price_e4 = decimal_to_e4(&metal.price.to_string())
        .ok_or("Spot gold came back in a shape this doesn't understand.")?;

    let url = format!("{FX_URL}?base=USD&symbols=INR");
    let fx: FxResponse = json_of(client, &url).await?;
    let inr = fx
        .rates
        .get("INR")
        .and_then(|n| decimal_to_e4(&n.to_string()))
        .ok_or("The rupee rate came back in a shape this doesn't understand.")?;

    let as_of = metal
        .updated_at
        .as_deref()
        .and_then(to_iso_date)
        .unwrap_or_else(today);
    Ok(vec![
        Quote {
            key: KEY_GOLD.into(),
            price_e4,
            as_of,
            source: "gold-api.com".into(),
        },
        Quote {
            key: KEY_FX.into(),
            price_e4: inr,
            as_of: to_iso_date(&fx.date).unwrap_or_else(today),
            source: "frankfurter.dev (ECB)".into(),
        },
    ])
}

async fn nav(client: &reqwest::Client, scheme_code: &str) -> Result<Quote> {
    let url = format!("{MFAPI_URL}/{scheme_code}/latest");
    let body: NavResponse = json_of(client, &url).await?;
    let point = body
        .data
        .first()
        .ok_or("That scheme has no NAV published yet.")?;
    Ok(Quote {
        key: format!("mf:{scheme_code}"),
        price_e4: decimal_to_e4(&point.nav).ok_or("That scheme's NAV came back unreadable.")?,
        as_of: to_iso_date(&point.date).unwrap_or_else(today),
        source: "mfapi.in (AMFI)".into(),
    })
}

/// `code;isin;isin2;name;plan;option;nav;date` — one line per scheme, with
/// fund-house names and blanks in between, which simply don't split into
/// eight fields and fall out on their own.
fn parse_amfi(body: &str, wanted: &[String]) -> Vec<Quote> {
    let mut quotes = Vec::new();
    for line in body.lines() {
        let fields: Vec<&str> = line.split(';').collect();
        if fields.len() < 8 {
            continue;
        }
        let code = fields[0].trim();
        if !wanted.iter().any(|w| w == code) {
            continue;
        }
        let Some(price_e4) = decimal_to_e4(fields[6]) else {
            continue;
        };
        quotes.push(Quote {
            key: format!("mf:{code}"),
            price_e4,
            as_of: to_iso_date(fields[7]).unwrap_or_else(today),
            source: "amfiindia.com".into(),
        });
    }
    quotes
}

/// The day `HISTORY_YEARS` ago, as the backfills' starting line.
fn history_start() -> String {
    (chrono::Utc::now().date_naive() - chrono::Duration::days(HISTORY_YEARS * 365))
        .format("%Y-%m-%d")
        .to_string()
}

/// Every NAV a scheme has ever had, newest first from mfapi. The whole file
/// arrives in one request, so the latest quote falls out of it too and the
/// scheme costs no more to backfill than to reprice.
async fn nav_history(client: &reqwest::Client, scheme_code: &str) -> Result<(Quote, Series)> {
    let body: NavResponse = json_of(client, &format!("{MFAPI_URL}/{scheme_code}")).await?;
    let key = format!("mf:{scheme_code}");
    let mut points: Vec<(String, Scaled)> = body
        .data
        .iter()
        .filter_map(|p| {
            let price = decimal_to_e4(&p.nav).filter(|nav| *nav > 0)?;
            Some((to_iso_date(&p.date)?, price))
        })
        .collect();
    points.sort();
    let (as_of, price_e4) = points
        .last()
        .cloned()
        .ok_or("That scheme has no NAV published yet.")?;
    Ok((
        Quote {
            key: key.clone(),
            price_e4,
            as_of,
            source: "mfapi.in (AMFI)".into(),
        },
        Series { key, points },
    ))
}

/// The LBMA's published fix and the ECB's rupee, over the same window. Both
/// are needed: a line of dollar prices with no rates beside it converts to
/// nothing, so a failure on either side throws the pair away.
async fn gold_history(client: &reqwest::Client) -> Result<Vec<Series>> {
    let start = history_start();
    let fixes: Vec<LbmaPoint> = json_of(client, LBMA_URL).await?;
    let metal: Vec<(String, Scaled)> = fixes
        .iter()
        .filter_map(|point| {
            let as_of = to_iso_date(&point.d)?;
            if as_of < start {
                return None;
            }
            let usd = point.v.first()?.as_ref()?;
            Some((as_of, decimal_to_e4(&usd.to_string()).filter(|p| *p > 0)?))
        })
        .collect();
    if metal.is_empty() {
        return Err("The gold price history came back empty.".into());
    }

    let url = format!("{FX_RANGE_URL}/{start}..?base=USD&symbols=INR");
    let fx: FxRangeResponse = json_of(client, &url).await?;
    let mut rupee: Vec<(String, Scaled)> = fx
        .rates
        .iter()
        .filter_map(|(date, rates)| {
            let inr = rates.get("INR")?;
            Some((to_iso_date(date)?, decimal_to_e4(&inr.to_string())?))
        })
        .collect();
    rupee.sort();
    if rupee.is_empty() {
        return Err("The rupee history came back empty.".into());
    }

    Ok(vec![
        Series { key: KEY_GOLD.into(), points: metal },
        Series { key: KEY_FX.into(), points: rupee },
    ])
}

/// Fetches prices for what the book actually holds.
///
/// A fund whose NAV won't load shouldn't stop gold from repricing, so partial
/// failures are kept rather than thrown away. Only a clean sweep of failures
/// is worth telling the user about.
///
/// The two `backfill` arguments name what has no history on file yet. Those
/// are asked for their whole published line rather than today's number; the
/// rest are only topped up, because every past day is already stored.
pub async fn fetch(
    want_gold: bool,
    schemes: &[String],
    backfill_gold: bool,
    backfill_schemes: &[String],
) -> Result<Fetched> {
    if !want_gold && schemes.is_empty() {
        return Ok(Fetched::default());
    }
    let client = client()?;
    let mut out = Fetched::default();

    if want_gold {
        if let Ok(mut pair) = gold(&client).await {
            out.quotes.append(&mut pair);
        }
        if backfill_gold {
            if let Ok(mut lines) = gold_history(&client).await {
                out.history.append(&mut lines);
            }
        }
    }
    for code in schemes {
        if backfill_schemes.iter().any(|c| c == code) {
            if let Ok((quote, series)) = nav_history(&client, code).await {
                out.quotes.push(quote);
                out.history.push(series);
                continue;
            }
        }
        if let Ok(quote) = nav(&client, code).await {
            out.quotes.push(quote);
        }
    }

    // mfapi republishes AMFI's numbers scheme by scheme. If it answered for
    // none of them, the published file itself is still there — one request
    // covers every fund at once.
    let got_navs = out.quotes.iter().any(|q| q.key.starts_with("mf:"));
    if !schemes.is_empty() && !got_navs {
        if let Ok(body) = text_of(&client, AMFI_URL).await {
            out.quotes.append(&mut parse_amfi(&body, schemes));
        }
    }

    if out.quotes.is_empty() {
        return Err(
            "Couldn't reach any price service. Holdings are showing the last prices fetched."
                .into(),
        );
    }
    Ok(out)
}

/// Scheme search for the fund picker. Three characters in before it is worth
/// asking — a one-letter query matches most of the market.
pub async fn search_schemes(query: &str) -> Result<Vec<Scheme>> {
    let query = query.trim();
    if query.len() < 3 {
        return Ok(Vec::new());
    }
    let client = client()?;
    // mfapi ranks its results, so it is worth asking first — unless it has
    // just failed, in which case asking again only costs another timeout.
    if !mfapi_is_resting() {
        match mfapi_search(&client, query).await {
            Ok(hits) => return Ok(hits),
            Err(_) => rest_mfapi(),
        }
    }
    // ...but it is one volunteer-run mirror of a list AMFI publishes itself,
    // and it does go down. Search the source instead.
    let all = amfi_schemes(&client).await?;
    Ok(match_schemes(&all, query))
}

async fn mfapi_search(client: &reqwest::Client, query: &str) -> Result<Vec<Scheme>> {
    let response = client
        .get(format!("{MFAPI_URL}/search"))
        .query(&[("q", query)])
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await
        .map_err(why)?;
    if !response.status().is_success() {
        return Err(format!("mfapi answered {}", response.status()));
    }
    let hits: Vec<SchemeHit> = response.json().await.map_err(why)?;
    Ok(hits
        .into_iter()
        .take(25)
        .map(|h| Scheme {
            scheme_code: h.scheme_code.to_string(),
            scheme_name: h.scheme_name,
        })
        .collect())
}

/// AMFI's list is 1.5 MB and only changes once a day, so it is fetched and
/// parsed at most once every few hours. The first fallback search pays for
/// that; every one after is instant, and survives the network going away.
static SCHEME_LIST: Mutex<Option<(Instant, Arc<Vec<Scheme>>)>> = Mutex::new(None);
const SCHEME_TTL: Duration = Duration::from_secs(6 * 60 * 60);

async fn amfi_schemes(client: &reqwest::Client) -> Result<Arc<Vec<Scheme>>> {
    // Taken and dropped before the fetch: a std lock cannot be held across an
    // await, and holding one over a network call would be wrong regardless.
    {
        let cached = SCHEME_LIST.lock().map_err(|e| e.to_string())?;
        if let Some((at, list)) = cached.as_ref() {
            if at.elapsed() < SCHEME_TTL {
                return Ok(Arc::clone(list));
            }
        }
    }
    let body = text_of(client, AMFI_URL).await?;
    let list = Arc::new(parse_scheme_list(&body));
    if list.is_empty() {
        return Err("AMFI's scheme list came back empty.".into());
    }
    *SCHEME_LIST.lock().map_err(|e| e.to_string())? = Some((Instant::now(), Arc::clone(&list)));
    Ok(list)
}

/// The same lines the NAV parser reads, kept for their names rather than their
/// prices. Plan and option fold into the name, so searching "direct" or
/// "growth" narrows things the way it does on mfapi.
fn parse_scheme_list(body: &str) -> Vec<Scheme> {
    let mut schemes = Vec::new();
    for line in body.lines() {
        let fields: Vec<&str> = line.split(';').collect();
        if fields.len() < 8 || fields[0].trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = [fields[3], fields[4], fields[5]]
            .into_iter()
            .map(str::trim)
            .filter(|p| !p.is_empty() && *p != "-")
            .collect();
        if parts.is_empty() {
            continue;
        }
        schemes.push(Scheme {
            scheme_code: fields[0].trim().to_string(),
            scheme_name: parts.join(" - "),
        });
    }
    schemes
}

/// Every word has to appear somewhere in the name, so "sbi small direct"
/// narrows instead of widening to everything matching any one of them.
fn match_schemes(all: &[Scheme], query: &str) -> Vec<Scheme> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    all.iter()
        .filter(|s| {
            let name = s.scheme_name.to_lowercase();
            words.iter().all(|w| name.contains(w.as_str()))
        })
        .take(25)
        .cloned()
        .collect()
}

