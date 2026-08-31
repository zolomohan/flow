use chrono::{Datelike, Duration, Local, NaiveDate};
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::db::{self, Result};
use crate::models::{TransactionInput, TransactionShareInput, TransactionSplitInput};

/// A tiny deterministic PRNG so the sample book looks hand-made but is
/// reproducible, without pulling in the `rand` crate.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// Inclusive on both ends.
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
    fn chance(&mut self, percent: i64) -> bool {
        self.range(1, 100) <= percent
    }
}

const ACCOUNTS: &[(&str, &str, &str, i64, &str, &str)] = &[
    // name, kind, institution, opening rupees, color, icon
    ("Savings", "bank", "HDFC Bank", 248_000, "#20294C", "landmark"),
    ("Salary Account", "bank", "ICICI Bank", 64_500, "#118AE4", "building-2"),
    ("Millennia Card", "credit", "HDFC Bank", 0, "#7C3AED", "credit-card"),
    ("Cash", "cash", "Wallet", 4_200, "#42C251", "wallet"),
    // Opens at nothing: what it holds is the cost of the units bought
    // through it, which the SIP transfers below put there.
    ("Index Funds", "investment", "Zerodha", 0, "#F0B429", "trending-up"),
];

const MERCHANTS: &[(&str, &str, i64, i64, u32)] = &[
    // merchant, category, min rupees, max rupees, relative frequency
    ("Swiggy", "Food & Drink", 220, 780, 10),
    ("Zomato", "Food & Drink", 190, 650, 8),
    ("Third Wave Coffee", "Food & Drink", 180, 420, 7),
    ("Blue Tokai", "Food & Drink", 250, 560, 4),
    ("Blinkit", "Groceries", 340, 1_600, 9),
    ("Zepto", "Groceries", 280, 1_200, 8),
    ("BigBasket", "Groceries", 900, 4_200, 2),
    ("Uber", "Transport", 90, 640, 9),
    ("Rapido", "Transport", 45, 210, 7),
    ("Namma Metro", "Transport", 30, 90, 8),
    ("Indian Oil", "Transport", 600, 2_500, 2),
    ("Myntra", "Shopping", 900, 5_400, 2),
    ("Amazon", "Shopping", 350, 6_800, 3),
    ("Decathlon", "Shopping", 800, 4_500, 1),
    ("Airtel Postpaid", "Bills & Utilities", 799, 999, 1),
    ("BESCOM", "Bills & Utilities", 1_200, 3_400, 1),
    ("ACT Fibernet", "Bills & Utilities", 1_100, 1_500, 1),
    ("Apollo Pharmacy", "Health", 220, 1_800, 3),
    ("Cult.fit", "Health", 1_800, 2_400, 1),
    ("PVR Cinemas", "Entertainment", 400, 1_600, 2),
    ("BookMyShow", "Entertainment", 300, 1_400, 2),
    ("Spotify", "Subscriptions", 119, 199, 1),
    ("Netflix", "Subscriptions", 199, 649, 1),
    ("iCloud+", "Subscriptions", 75, 219, 1),
    ("IndiGo", "Travel", 3_200, 11_500, 1),
    ("Airbnb", "Travel", 4_000, 14_000, 1),
    ("Coursera", "Education", 999, 3_800, 1),
    ("Blume Books", "Education", 350, 1_400, 2),
];

/// Cumulative weights, so the everyday merchants come up far more often than
/// the once-a-quarter flight.
fn weighted_merchant(rng: &mut Rng) -> (&'static str, &'static str, i64, i64) {
    let total: u32 = MERCHANTS.iter().map(|m| m.4).sum();
    let mut roll = rng.range(1, total as i64) as u32;
    for (name, category, lo, hi, weight) in MERCHANTS {
        if roll <= *weight {
            return (name, category, *lo, *hi);
        }
        roll -= *weight;
    }
    let last = MERCHANTS[MERCHANTS.len() - 1];
    (last.0, last.1, last.2, last.3)
}

fn rupees(n: i64) -> i64 {
    n * 100
}

/// Builds roughly eight months of believable history so a first launch has
/// something to look at instead of a wall of empty states.
pub fn seed(conn: &Connection) -> Result<()> {
    let mut rng = Rng(0x5EED_1DEA_C0FF_EE01);
    let today = Local::now().date_naive();

    let mut account_ids: Vec<(String, &str)> = Vec::new();
    for (i, (name, kind, inst, opening, color, icon)) in ACCOUNTS.iter().enumerate() {
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO accounts (id, name, kind, institution, opening_balance, color, icon,
                                   archived, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
            params![
                id,
                name,
                kind,
                inst,
                rupees(*opening),
                color,
                icon,
                i as i64,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| e.to_string())?;
        account_ids.push((id, kind));
    }

    let cats = db::list_categories(conn)?;
    let cat_id = |name: &str| -> Option<String> {
        cats.iter().find(|c| c.name == name).map(|c| c.id.clone())
    };

    let savings = account_ids[0].0.clone();
    let salary_ac = account_ids[1].0.clone();
    let card = account_ids[2].0.clone();
    let cash = account_ids[3].0.clone();
    let investments = account_ids[4].0.clone();

    let mut insert = conn
        .prepare(
            "INSERT INTO transactions (id, kind, amount, account_id, to_account_id, category_id,
                                       merchant, note, occurred_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .map_err(|e| e.to_string())?;

    let mut write = |kind: &str,
                     amount: i64,
                     account: &str,
                     to: Option<&str>,
                     category: Option<String>,
                     merchant: &str,
                     day: NaiveDate,
                     hour: i64,
                     minute: i64|
     -> Result<String> {
        let id = Uuid::new_v4().to_string();
        insert
            .execute(params![
                id,
                kind,
                amount,
                account,
                to,
                category,
                merchant,
                Option::<String>::None,
                format!("{}T{:02}:{:02}", day.format("%Y-%m-%d"), hour, minute),
                chrono::Utc::now().to_rfc3339()
            ])
            .map_err(|e| e.to_string())?;
        Ok(id)
    };

    let start = today - Duration::days(400);
    // Every SIP posting, kept so each one can back a lot of units.
    let mut sips: Vec<(NaiveDate, String)> = Vec::new();
    let salary_cat = cat_id("Salary");
    let interest_cat = cat_id("Interest");
    let rent_cat = cat_id("Rent & Home");

    let mut day = start;
    while day <= today {
        // Salary on the 1st, rent on the 3rd, a little interest at month end.
        if day.day() == 1 {
            let bump = rng.range(0, 6) * 1_000;
            write(
                "income",
                rupees(142_000 + bump),
                &salary_ac,
                None,
                salary_cat.clone(),
                "Monthly salary",
                day,
                10,
                rng.range(0, 40),
            )?;
            // Most of the salary is swept into savings, which is the
            // account every standing cost is paid from.
            write(
                "transfer",
                rupees(rng.range(112, 124) * 1_000),
                &salary_ac,
                Some(&savings),
                None,
                "To savings",
                day,
                11,
                rng.range(0, 50),
            )?;
        }
        if day.day() == 3 {
            write(
                "expense",
                rupees(38_000),
                &savings,
                None,
                rent_cat.clone(),
                "Rent — Indiranagar",
                day,
                9,
                15,
            )?;
        }
        if day.day() == 5 {
            let posting = write(
                "transfer",
                rupees(15_000),
                &savings,
                Some(&investments),
                None,
                "SIP — Nifty 50",
                day,
                8,
                0,
            )?;
            sips.push((day, posting));
        }
        if day.day() == 12 && rng.chance(70) {
            write(
                "transfer",
                rupees(rng.range(3, 8) * 1_000),
                &savings,
                Some(&cash),
                None,
                "ATM withdrawal",
                day,
                18,
                rng.range(0, 55),
            )?;
        }
        if day.day() == 28 {
            write(
                "income",
                rupees(rng.range(600, 2_400)),
                &savings,
                None,
                interest_cat.clone(),
                "Savings interest",
                day,
                23,
                30,
            )?;
        }
        // Card statement gets cleared mid-month.
        if day.day() == 18 {
            let owed: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0) FROM transactions
                     WHERE account_id = ?1 AND kind = 'expense' AND occurred_at < ?2",
                    params![card, format!("{}T00:00", day.format("%Y-%m-%d"))],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let paid: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0) FROM transactions
                     WHERE to_account_id = ?1 AND kind = 'transfer' AND occurred_at < ?2",
                    params![card, format!("{}T00:00", day.format("%Y-%m-%d"))],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let due = owed - paid;
            if due > 0 {
                write(
                    "transfer",
                    due,
                    &savings,
                    Some(&card),
                    None,
                    "Credit card payment",
                    day,
                    20,
                    5,
                )?;
            }
        }

        // Everyday spending: two to five purchases, weekends a little heavier.
        let weekend = matches!(
            day.weekday(),
            chrono::Weekday::Sat | chrono::Weekday::Sun
        );
        let count = if weekend { rng.range(2, 4) } else { rng.range(1, 2) };
        for _ in 0..count {
            let (merchant, category, lo, hi) = weighted_merchant(&mut rng);
            // Small, everyday amounts tend to be cash; the rest hit the card.
            let amount = rupees(rng.range(lo, hi));
            let account = if amount < rupees(300) && rng.chance(45) {
                &cash
            } else if rng.chance(70) {
                &card
            } else {
                &savings
            };
            write(
                "expense",
                amount,
                account,
                None,
                cat_id(category),
                merchant,
                day,
                rng.range(8, 22),
                rng.range(0, 59),
            )?;
        }
        day += Duration::days(1);
    }

    // One bill that shows both halves of splitting: a dinner filed under two
    // categories at once, and shared with the two people who were at it. The
    // ledger still sees a single ₹4,800 expense — being owed ₹3,200 of it back
    // is two debts on the Debts screen, not a smaller night out.
    let dinner = today - Duration::days(9);
    db::save_transaction(
        conn,
        TransactionInput {
            id: None,
            kind: "expense".into(),
            amount: rupees(4_800),
            account_id: card.clone(),
            to_account_id: None,
            category_id: cat_id("Food & Drink"),
            merchant: "Toit — birthday dinner".into(),
            note: Some("Split three ways".into()),
            occurred_at: format!("{}T21:15", dinner.format("%Y-%m-%d")),
            splits: Some(vec![
                TransactionSplitInput {
                    id: None,
                    amount: rupees(3_300),
                    category_id: cat_id("Food & Drink"),
                    note: Some("Food and the tab".into()),
                },
                TransactionSplitInput {
                    id: None,
                    amount: rupees(1_500),
                    category_id: cat_id("Entertainment"),
                    note: Some("Cake and the cab home".into()),
                },
            ]),
            shares: Some(vec![
                TransactionShareInput {
                    id: None,
                    direction: "lent".into(),
                    counterparty: "Suhruth".into(),
                    amount: rupees(1_600),
                    due_on: None,
                    note: None,
                },
                TransactionShareInput {
                    id: None,
                    direction: "lent".into(),
                    counterparty: "Nikhil".into(),
                    amount: rupees(1_600),
                    due_on: None,
                    note: None,
                },
            ]),
            label_ids: None,
            refund_of: None,
        },
    )?;

    seed_holdings(conn, &investments, &sips)
}

/// Two holdings, one of each shape the Investments screen knows about.
///
/// The gold is simply weighed — nothing in the ledger backs it, so its whole
/// value is new to the balance sheet. The index fund is the other case: every
/// SIP transfer above is the posting behind one lot, so the cash already sits
/// in the investment account as cost basis and only the gain counts again.
fn seed_holdings(
    conn: &Connection,
    investment_account: &str,
    sips: &[(NaiveDate, String)],
) -> Result<()> {
    let created = chrono::Utc::now().to_rfc3339();

    // Bought a year and a half ago, so the sample book's value line has a day
    // to start from rather than running back to the beginning of the market.
    let acquired = (chrono::Utc::now().date_naive() - chrono::Duration::days(540))
        .format("%Y-%m-%d")
        .to_string();
    conn.execute(
        "INSERT INTO holdings (id, kind, name, purity_e4, grams_e4, note, created_at,
                               acquired_on)
         VALUES (?1, 'gold', ?2, 9160, 205000, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            "Gold — coins & chain",
            "22K, in the locker",
            created,
            acquired
        ],
    )
    .map_err(|e| e.to_string())?;

    let fund = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO holdings (id, kind, name, account_id, scheme_code, isin, created_at)
         VALUES (?1, 'fund', ?2, ?3, '120716', 'INF789F01XA0', ?4)",
        params![
            fund,
            "UTI Nifty 50 Index Fund - Direct Plan - Growth",
            investment_account,
            created
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut lot = conn
        .prepare(
            "INSERT INTO investment_lots (id, holding_id, kind, quantity_e4, amount,
                                          occurred_at, allotted_at, transaction_id,
                                          created_at)
             VALUES (?1, ?2, 'buy', ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .map_err(|e| e.to_string())?;

    for (i, (day, posting)) in sips.iter().enumerate() {
        // A NAV walking gently upwards over the run, so the position shows a
        // believable gain rather than a suspiciously round one.
        let nav_e4 = 1_480_000 + i as i64 * 17_000;
        let amount = rupees(15_000);
        // units = rupees ÷ NAV, with both sides carrying their 10^4 scale.
        let units_e4 = (amount as i128 * 1_000_000 / nav_e4 as i128) as i64;
        // The debit clears on the mandate date; the AMC allots two days later,
        // at that day's NAV — which is the NAV these units were bought at.
        let allotted = (*day + Duration::days(2)).min(Local::now().date_naive());
        lot.execute(params![
            Uuid::new_v4().to_string(),
            fund,
            units_e4,
            amount,
            day.format("%Y-%m-%d").to_string(),
            allotted.format("%Y-%m-%d").to_string(),
            posting,
            created
        ])
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
