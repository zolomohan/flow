mod db;
mod demo;
mod models;
mod prices;

use std::sync::Mutex;
use tauri::{Manager, State};

use db::Db;
use models::*;

type R<T> = std::result::Result<T, String>;

/// Runs `f` with the single shared connection held open for the app's lifetime.
fn with_db<T>(db: &State<Db>, f: impl FnOnce(&rusqlite::Connection) -> R<T>) -> R<T> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

#[tauri::command]
fn list_accounts(db: State<Db>) -> R<Vec<Account>> {
    with_db(&db, db::list_accounts)
}

#[tauri::command]
fn save_account(db: State<Db>, input: AccountInput) -> R<Account> {
    with_db(&db, |c| db::save_account(c, input))
}

#[tauri::command]
fn set_account_archived(db: State<Db>, id: String, archived: bool) -> R<()> {
    with_db(&db, |c| db::set_account_archived(c, &id, archived))
}

#[tauri::command]
fn delete_account(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_account(c, &id))
}

#[tauri::command]
fn reorder_accounts(db: State<Db>, ids: Vec<String>) -> R<()> {
    with_db(&db, |c| db::reorder_accounts(c, ids))
}

#[tauri::command]
fn list_categories(db: State<Db>) -> R<Vec<Category>> {
    with_db(&db, db::list_categories)
}

#[tauri::command]
fn save_category(db: State<Db>, input: CategoryInput) -> R<Category> {
    with_db(&db, |c| db::save_category(c, input))
}

#[tauri::command]
fn category_usage(db: State<Db>) -> R<std::collections::HashMap<String, i64>> {
    with_db(&db, db::category_usage)
}

#[tauri::command]
fn reassign_category(
    db: State<Db>,
    from: String,
    to: String,
    include_children: bool,
) -> R<i64> {
    with_db(&db, |c| db::reassign_category(c, &from, &to, include_children))
}

#[tauri::command]
fn delete_category(
    db: State<Db>,
    id: String,
    reassign_to: Option<String>,
    delete_children: bool,
) -> R<()> {
    with_db(&db, |c| db::delete_category(c, &id, reassign_to, delete_children))
}

#[tauri::command]
fn list_transactions(db: State<Db>, query: Option<TransactionQuery>) -> R<Vec<Transaction>> {
    with_db(&db, |c| db::list_transactions(c, query.unwrap_or_default()))
}

#[tauri::command]
fn transaction_summary(db: State<Db>, query: Option<TransactionQuery>) -> R<TransactionSummary> {
    with_db(&db, |c| db::transaction_summary(c, query.unwrap_or_default()))
}

/// One posting, by id — for opening whatever a debt or a repayment names.
#[tauri::command]
fn transaction(db: State<Db>, id: String) -> R<Transaction> {
    with_db(&db, |c| db::get_transaction(c, &id))
}

#[tauri::command]
fn save_transaction(db: State<Db>, input: TransactionInput) -> R<Transaction> {
    with_db(&db, |c| db::save_transaction(c, input))
}

/// One change over many postings — the ledger's own bulk edit.
#[tauri::command]
fn update_transactions(
    db: State<Db>,
    ids: Vec<String>,
    patch: TransactionPatch,
) -> R<BulkResult> {
    with_db(&db, |c| db::update_transactions(c, &ids, patch))
}

#[tauri::command]
fn delete_transactions(db: State<Db>, ids: Vec<String>) -> R<i64> {
    with_db(&db, |c| db::delete_transactions(c, &ids))
}

#[tauri::command]
fn delete_transaction(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_transaction(c, &id))
}

#[tauri::command]
fn list_debts(db: State<Db>) -> R<Vec<Debt>> {
    with_db(&db, db::list_debts)
}

#[tauri::command]
fn save_debt(db: State<Db>, input: DebtInput) -> R<()> {
    with_db(&db, |c| db::save_debt(c, input))
}

/// The postings one debt is made of.
#[tauri::command]
fn debt_entries(db: State<Db>, id: String) -> R<Vec<Transaction>> {
    with_db(&db, |c| db::debt_entries(c, &id))
}

#[tauri::command]
fn delete_debt(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_debt(c, &id))
}

#[tauri::command]
fn save_debt_payment(db: State<Db>, input: DebtPaymentInput) -> R<()> {
    with_db(&db, |c| db::save_debt_payment(c, input))
}

#[tauri::command]
fn delete_debt_payment(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_debt_payment(c, &id))
}

#[tauri::command]
fn list_holdings(db: State<Db>) -> R<Vec<Holding>> {
    with_db(&db, db::list_holdings)
}

#[tauri::command]
fn save_holding(db: State<Db>, input: HoldingInput) -> R<()> {
    with_db(&db, |c| db::save_holding(c, input))
}

#[tauri::command]
fn delete_holding(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_holding(c, &id))
}

#[tauri::command]
fn save_investment_lot(db: State<Db>, input: InvestmentLotInput) -> R<()> {
    with_db(&db, |c| db::save_investment_lot(c, input))
}

#[tauri::command]
fn delete_investment_lot(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_investment_lot(c, &id))
}

/// Fetches prices for whatever is held and caches them.
///
/// The lock is taken twice around the network call rather than held across
/// it: a `MutexGuard` is not `Send`, so keeping one over an `await` would not
/// compile, and holding it would freeze every other command besides.
#[tauri::command]
async fn refresh_prices(db: State<'_, Db>) -> R<()> {
    let (want_gold, schemes, backfill_gold, backfill_schemes) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (want_gold, schemes) = db::price_keys_needed(&conn)?;
        let (backfill_gold, backfill_schemes) = db::price_backfill_needed(&conn)?;
        (want_gold, schemes, backfill_gold, backfill_schemes)
    };
    let fetched =
        prices::fetch(want_gold, &schemes, backfill_gold, &backfill_schemes).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for series in &fetched.history {
        db::store_history(&conn, &series.key, &series.points)?;
    }
    db::store_prices(&conn, &fetched.quotes)
}

/// One holding's price line, for its own page. `days` bounds the window;
/// leaving it off asks for everything on file.
#[tauri::command]
fn holding_series(db: State<Db>, id: String, days: Option<i64>) -> R<Vec<PricePoint>> {
    with_db(&db, |c| db::holding_series(c, &id, days))
}

/// Every holding's line at once, keyed by holding id — one call behind a
/// screen full of sparklines.
#[tauri::command]
fn holding_series_all(
    db: State<Db>,
    days: Option<i64>,
) -> R<std::collections::HashMap<String, Vec<PricePoint>>> {
    with_db(&db, |c| db::holding_series_all(c, days))
}

/// What the gold in the book has been worth, day by day.
#[tauri::command]
fn gold_value_series(
    db: State<Db>,
    days: Option<i64>,
    purity_e4: Option<i64>,
) -> R<Vec<ValuePoint>> {
    with_db(&db, |c| db::gold_value_series(c, days, purity_e4))
}

#[tauri::command]
async fn search_schemes(query: String) -> R<Vec<Scheme>> {
    prices::search_schemes(&query).await
}

#[tauri::command]
fn overview(db: State<Db>, month: String, span: Option<u32>) -> R<Overview> {
    with_db(&db, |c| db::overview(c, &month, span.unwrap_or(1)))
}

#[tauri::command]
fn get_setting(db: State<Db>, key: String) -> R<Option<String>> {
    with_db(&db, |c| db::setting(c, &key))
}

#[tauri::command]
fn list_settings(db: State<Db>) -> R<std::collections::HashMap<String, String>> {
    with_db(&db, db::settings)
}

#[tauri::command]
fn set_setting(db: State<Db>, key: String, value: String) -> R<()> {
    with_db(&db, |c| db::set_setting(c, &key, &value))
}

/// Writes the whole book to a file of the user's choosing.
#[tauri::command]
fn export_book(db: State<Db>, to: String) -> R<String> {
    let path = std::path::PathBuf::from(&to);
    with_db(&db, |c| db::export_book(c, &path))?;
    Ok(to)
}

/// Reads one back over this book, keeping a copy of what was here beside it.
#[tauri::command]
fn import_book(db: State<Db>, from: String) -> R<String> {
    let source = std::path::PathBuf::from(&from);
    let backup = source.with_file_name(format!(
        "midas-replaced-{}.sqlite3",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    with_db(&db, |c| db::import_book(c, &source, &backup))?;
    Ok(backup.to_string_lossy().into_owned())
}

#[tauri::command]
fn reset_all(db: State<Db>) -> R<()> {
    with_db(&db, db::reset)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Picking where a copy of the book goes, and which one to read back.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("midas.sqlite3")).map_err(std::io::Error::other)?;

            // A brand-new book gets sample data once, so the first launch has
            // something to show. Wiping from Settings sets the flag and sticks.
            let seeded = db::setting(&conn, "seeded").map_err(std::io::Error::other)?;
            if seeded.is_none() && !db::has_any_data(&conn).map_err(std::io::Error::other)? {
                demo::seed(&conn).map_err(std::io::Error::other)?;
                db::set_setting(&conn, "seeded", "1").map_err(std::io::Error::other)?;
            }

            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            save_account,
            set_account_archived,
            delete_account,
            reorder_accounts,
            list_categories,
            save_category,
            category_usage,
            reassign_category,
            delete_category,
            list_transactions,
            transaction_summary,
            transaction,
            save_transaction,
            delete_transaction,
            update_transactions,
            delete_transactions,
            overview,
            list_debts,
            save_debt,
            delete_debt,
            debt_entries,
            save_debt_payment,
            delete_debt_payment,
            list_holdings,
            save_holding,
            delete_holding,
            save_investment_lot,
            delete_investment_lot,
            refresh_prices,
            holding_series,
            holding_series_all,
            gold_value_series,
            search_schemes,
            get_setting,
            list_settings,
            set_setting,
            export_book,
            import_book,
            reset_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
