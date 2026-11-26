mod ai;
mod capture;
mod chat;
mod cards;
mod cashback;
mod db;
mod demo;
mod folders;
mod import;
mod models;
mod plans;
mod prices;
mod tax;

use std::sync::Mutex;
use tauri::{Manager, State};

use db::Db;
use models::*;

type R<T> = std::result::Result<T, String>;

/// Runs `f` with the single shared connection held open for the app's lifetime.
///
/// Anything that wrote to the book is followed by bringing card cashback into
/// line with it. A purchase can reach a card from a dozen places — the sheet,
/// an import, a plan paid, a sentence said to the phone, a bulk edit — and
/// every one of them changes what the cycle earned and what it is credited,
/// so it is done once here rather than remembered at each of them.
fn with_db<T>(db: &State<Db>, f: impl FnOnce(&rusqlite::Connection) -> R<T>) -> R<T> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let before = conn.total_changes();
    let out = f(&conn);
    if conn.total_changes() != before {
        if let Err(e) = cashback::settle(&conn) {
            eprintln!("cashback could not be settled: {e}");
        }
    }
    out
}

#[tauri::command]
fn list_accounts(db: State<Db>) -> R<Vec<Account>> {
    with_db(&db, |c| {
        // Read on every refresh, so it is also where a cycle that closed while
        // the app sat open gets its credit: nothing else changed to say so.
        cashback::settle(c)?;
        db::list_accounts(c)
    })
}

#[tauri::command]
fn save_account(db: State<Db>, input: AccountInput) -> R<Account> {
    with_db(&db, |c| {
        let account = db::save_account(c, input)?;
        // The phone names accounts by the words in its word list. Rewriting
        // it here is what makes an account openable and immediately sayable.
        let _ = capture::write_book(c);
        Ok(account)
    })
}

#[tauri::command]
fn set_account_archived(db: State<Db>, id: String, archived: bool) -> R<()> {
    with_db(&db, |c| {
        db::set_account_archived(c, &id, archived)?;
        // An archived account can take nothing, so it leaves the word list.
        let _ = capture::write_book(c);
        Ok(())
    })
}

#[tauri::command]
fn delete_account(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| {
        db::delete_account(c, &id)?;
        let _ = capture::write_book(c);
        Ok(())
    })
}

#[tauri::command]
fn reorder_accounts(db: State<Db>, ids: Vec<String>) -> R<()> {
    with_db(&db, |c| {
        db::reorder_accounts(c, ids)?;
        let _ = capture::write_book(c);
        Ok(())
    })
}

#[tauri::command]
fn list_categories(db: State<Db>) -> R<Vec<Category>> {
    with_db(&db, db::list_categories)
}

#[tauri::command]
fn save_category(db: State<Db>, input: CategoryInput) -> R<Category> {
    with_db(&db, |c| {
        let category = db::save_category(c, input)?;
        let _ = capture::write_book(c);
        Ok(category)
    })
}

#[tauri::command]
fn reorder_categories(db: State<Db>, ids: Vec<String>) -> R<()> {
    with_db(&db, |c| {
        db::reorder_categories(c, ids)?;
        // The word list is read in the order it is written, and the order is
        // yours: what you keep at the top is what the model sees first.
        let _ = capture::write_book(c);
        Ok(())
    })
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
    with_db(&db, |c| {
        db::delete_category(c, &id, reassign_to, delete_children)?;
        let _ = capture::write_book(c);
        Ok(())
    })
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

/// Reads a bank statement export into rows. Pure — nothing touches the book
/// until the preview has been seen and the commit asked for.
/// The days a card's terms changed, oldest first.
#[tauri::command]
fn card_terms(db: State<Db>, account_id: String) -> R<Vec<CardTerm>> {
    with_db(&db, |c| cards::card_terms(c, &account_id))
}

/// Records what a card's terms became on a day — its limit, the day its
/// statement closes, the day the bill is due, or any of them. One dated today
/// also moves the card itself, so the two never disagree.
#[tauri::command]
fn save_card_term(
    db: State<Db>,
    account_id: String,
    effective_on: String,
    credit_limit: Option<Paise>,
    statement_day: Option<i64>,
    due_day: Option<i64>,
    cashback_rate_e4: Option<i64>,
    cashback_cap: Option<Paise>,
    note: Option<String>,
) -> R<CardTerm> {
    with_db(&db, |c| {
        cards::save_card_term(
            c,
            &account_id,
            &effective_on,
            credit_limit,
            statement_day,
            due_day,
            cashback_rate_e4,
            cashback_cap,
            note.as_deref(),
        )
    })
}

/// What a purchase being written would earn back on the card it is on —
/// asked before it is saved, so the sheet can say what it will cost.
#[tauri::command]
fn cashback_quote(
    db: State<Db>,
    account_id: String,
    occurred_at: String,
    amount: Paise,
    id: Option<String>,
) -> R<CashbackQuote> {
    with_db(&db, |c| cashback::quote(c, &account_id, &occurred_at, amount, id.as_deref()))
}

#[tauri::command]
fn delete_card_term(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| cards::delete_card_term(c, &id))
}

/// Every credit card at once: what is owed, what has been billed, and what
/// the window on screen was spent on.
#[tauri::command]
fn cards(
    db: State<Db>,
    month: String,
    span: Option<u32>,
    from: Option<String>,
    to: Option<String>,
) -> R<CardsOverview> {
    with_db(&db, |c| {
        // The card page can be the first thing read after a cycle closes, so
        // the credit is written before it is read rather than on the next
        // refresh.
        cashback::settle(c)?;
        cards::cards_overview(c, &month, span.unwrap_or(1), from.as_deref(), to.as_deref())
    })
}

/// A financial year of earnings, grouped by the head each is filed under —
/// and, just as loudly, by what has not been filed at all. No tax is
/// computed here on purpose: see `tax.rs`.
#[tauri::command]
fn tax_year(db: State<Db>, fy: i32) -> R<TaxYear> {
    with_db(&db, |c| tax::tax_year(c, fy))
}

/// Which financial years the book has anything to say about.
#[tauri::command]
fn tax_years(db: State<Db>) -> R<Vec<i32>> {
    with_db(&db, tax::tax_years)
}

/// Every category that has been given a tax head, as `categoryId -> tag`.
#[tauri::command]
fn tax_map(db: State<Db>) -> R<std::collections::HashMap<String, String>> {
    with_db(&db, tax::tax_map)
}

/// Files a category under a head. A null tag puts it back on the undecided
/// pile, which is a real answer rather than an absence of one.
#[tauri::command]
fn set_tax_tag(db: State<Db>, category_id: String, tag: Option<String>) -> R<()> {
    with_db(&db, |c| tax::set_tax_tag(c, &category_id, tag.clone()))
}

/// The year as CSV, one row per posting, for whoever actually files it.
#[tauri::command]
fn tax_export(db: State<Db>, fy: i32) -> R<String> {
    with_db(&db, |c| tax::tax_export(c, fy))
}

#[tauri::command]
fn parse_statement(path: String) -> R<Vec<StatementRow>> {
    import::parse_statement(&path)
}

/// Holds parsed rows against one account: which are already in the book, and
/// how the new ones would be filed.
#[tauri::command]
fn preview_statement_import(
    db: State<Db>,
    account_id: String,
    rows: Vec<StatementRow>,
) -> R<Vec<ImportPreviewRow>> {
    with_db(&db, |c| db::preview_import(c, &account_id, rows))
}

/// Posts the agreed rows, wearing the Triage label where asked. A row marked
/// as not affecting the balance is absorbed by the opening balances it
/// touches, so recording it moves nothing.
#[tauri::command]
fn commit_statement_import(
    db: State<Db>,
    account_id: String,
    rows: Vec<ImportCommitRow>,
) -> R<ImportResult> {
    with_db(&db, |c| db::commit_import(c, &account_id, rows))
}

/// Where Claude's credential would come from, and what else is set up.
/// Asking `ant` for a token blocks on a subprocess, so it runs off the main
/// thread.
#[tauri::command]
async fn ai_status() -> R<ai::AiStatus> {
    tauri::async_runtime::spawn_blocking(ai::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ai_save_key(key: String) -> R<()> {
    ai::save_key(&key)
}

#[tauri::command]
fn ai_forget_key() -> R<()> {
    ai::forget_key()
}

/// Checks the credential against the API; answers with the model's name.
#[tauri::command]
async fn ai_test() -> R<String> {
    ai::test().await
}

/// Reads statements with Claude into rows the importer can preview. The
/// book is only read, for the categories and accounts to choose between,
/// and the lock is let go before the first byte is sent.
#[tauri::command]
async fn ai_read_statements(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    run: String,
    paths: Vec<String>,
    account_id: String,
    from: String,
    to: String,
) -> R<Vec<ai::AiRow>> {
    let (account, categories, accounts) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let accounts = db::list_accounts(&conn)?;
        let categories = db::list_categories(&conn)?;
        let account = accounts
            .iter()
            .find(|a| a.id == account_id)
            .cloned()
            .ok_or("That account no longer exists.")?;
        let accounts: Vec<Account> =
            accounts.into_iter().filter(|a| !a.archived && !a.system).collect();
        (account, categories, accounts)
    };
    ai::read_statements(app, run, paths, account, from, to, categories, accounts).await
}

/// Answers a question about the book with Claude. `messages` is the whole
/// conversation in the API's own shape, ending with the new question; the
/// answer comes back as that conversation with Claude's turns added, and
/// streams in meanwhile as `ai-chat-progress` events tagged with `run`.
/// Claude reads through a read-only connection of its own. A change it asks
/// for ends the call with the change pending; calling again with the user's
/// `decisions` (tool call id → applied) makes the applied ones through the
/// app's own save functions and carries on.
#[tauri::command]
async fn ai_chat(
    app: tauri::AppHandle,
    book: State<'_, chat::BookPath>,
    run: String,
    messages: Vec<serde_json::Value>,
    decisions: Option<std::collections::HashMap<String, bool>>,
) -> R<chat::ChatReply> {
    chat::ask(app, run, book.0.clone(), messages, decisions.unwrap_or_default()).await
}

/// Asks a chat run to stop where it is.
#[tauri::command]
fn ai_chat_stop(run: String) {
    chat::stop(&run);
}

#[tauri::command]
fn list_labels(db: State<Db>) -> R<Vec<Label>> {
    with_db(&db, db::list_labels)
}

#[tauri::command]
fn save_label(db: State<Db>, input: LabelInput) -> R<Label> {
    with_db(&db, |c| db::save_label(c, input))
}

#[tauri::command]
fn delete_label(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_label(c, &id))
}

/// Pins one label across a selection, or takes it off. Answers with how many
/// postings it actually changed.
#[tauri::command]
fn label_transactions(
    db: State<Db>,
    ids: Vec<String>,
    label_id: String,
    on: bool,
) -> R<i64> {
    with_db(&db, |c| db::label_transactions(c, &ids, &label_id, on))
}

/// Every folder, with what it holds already added up.
#[tauri::command]
fn list_folders(db: State<Db>) -> R<Vec<Folder>> {
    with_db(&db, folders::list_folders)
}

#[tauri::command]
fn save_folder(db: State<Db>, input: FolderInput) -> R<Folder> {
    with_db(&db, |c| folders::save_folder(c, input))
}

/// The folder goes; every posting it held stays exactly where it was.
#[tauri::command]
fn delete_folder(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| folders::delete_folder(c, &id))
}

/// Puts postings in a folder, answering with how many were not already in it.
#[tauri::command]
fn add_to_folder(db: State<Db>, folder_id: String, ids: Vec<String>) -> R<i64> {
    with_db(&db, |c| folders::add_postings(c, &folder_id, &ids))
}

/// Takes postings back out of one. They are untouched otherwise.
#[tauri::command]
fn remove_from_folder(db: State<Db>, folder_id: String, ids: Vec<String>) -> R<()> {
    with_db(&db, |c| folders::remove_postings(c, &folder_id, &ids))
}

/// Every saved template, what you reach for most at the top.
#[tauri::command]
fn list_templates(db: State<Db>) -> R<Vec<TxTemplate>> {
    with_db(&db, db::list_templates)
}

/// Writes a template whole — a name given to the shape of a posting.
#[tauri::command]
fn save_template(db: State<Db>, input: TxTemplateInput) -> R<TxTemplate> {
    with_db(&db, |c| db::save_template(c, input))
}

/// The template goes; every posting written from it stays.
#[tauri::command]
fn delete_template(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_template(c, &id))
}

/// Counts one posting written from a template. Called after the posting is
/// saved, so a template opened and thought better of was never used.
#[tauri::command]
fn use_template(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::touch_template(c, &id))
}

/// "These are filed right": clears Triage and teaches the importer, so the
/// next statement classifies these counterparties on its own.
#[tauri::command]
fn confirm_triage(db: State<Db>, ids: Vec<String>) -> R<i64> {
    with_db(&db, |c| db::confirm_triage(c, &ids))
}

/* --------------------------------------------------------------- captures */

/// Reads whatever the phone has dictated into the drop file, files what it
/// can, and writes the word list back out. Safe to call as often as you like:
/// a line already read is refused by its own digest.
#[tauri::command]
fn sync_captures(db: State<Db>) -> R<CaptureSync> {
    with_db(&db, capture::sync)
}

#[tauri::command]
fn list_captures(db: State<Db>) -> R<Vec<Capture>> {
    with_db(&db, capture::pending)
}

/// Everything said out loud that made it into the ledger, newest first.
#[tauri::command]
fn capture_history(db: State<Db>) -> R<Vec<Capture>> {
    with_db(&db, capture::history)
}

/// Everyone this book has paid or been paid by, most seen first — what the
/// merchant field offers as you type.
#[tauri::command]
fn known_merchants(db: State<Db>) -> R<Vec<String>> {
    with_db(&db, |c| capture::known_merchants(c, None))
}

/// Writes one waiting capture into the ledger, with whatever the Inbox
/// filled in for what the resolver could not work out.
#[tauri::command]
fn post_capture(db: State<Db>, id: String, input: TransactionInput) -> R<Transaction> {
    with_db(&db, |c| capture::post(c, &id, input))
}

#[tauri::command]
fn dismiss_capture(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| capture::dismiss(c, &id))
}

/// Where the drop file and the word list live, so Settings can say so.
#[tauri::command]
fn capture_paths(db: State<Db>) -> R<(String, String)> {
    with_db(&db, |c| {
        Ok((
            capture::inbox_path(c).to_string_lossy().into_owned(),
            capture::book_text_path(c).to_string_lossy().into_owned(),
        ))
    })
}

/* ------------------------------------------------------- planned payments */

/// Every plan, with what the ledger says about each: when it next falls due,
/// what it has actually been costing, and whether anything has been missed.
#[tauri::command]
fn list_plans(db: State<Db>) -> R<Vec<Plan>> {
    with_db(&db, plans::list_plans)
}

#[tauri::command]
fn save_plan(db: State<Db>, input: PlanInput) -> R<Plan> {
    with_db(&db, |c| plans::save_plan(c, input))
}

#[tauri::command]
fn delete_plan(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| plans::delete_plan(c, &id))
}

#[tauri::command]
fn set_plan_archived(db: State<Db>, id: String, archived: bool) -> R<()> {
    with_db(&db, |c| plans::set_plan_archived(c, &id, archived))
}

/// Lets the cycle now due go by unpaid — a waived bill, a month off.
#[tauri::command]
fn skip_plan(db: State<Db>, id: String) -> R<Plan> {
    with_db(&db, |c| plans::skip_plan(c, &id))
}

/// Writes the posting this cycle was reviewed into and points the plan at it.
#[tauri::command]
fn pay_plan(db: State<Db>, id: String, input: TransactionInput) -> R<Transaction> {
    with_db(&db, |c| plans::pay_plan(c, &id, input))
}

/// Every turn of every live plan between two dates, paid ones included.
#[tauri::command]
fn plan_calendar(db: State<Db>, from: String, to: String) -> R<Vec<PlanOccurrence>> {
    with_db(&db, |c| plans::plan_calendar(c, &from, &to))
}

/// The whole life of one plan, oldest cycle first — paid, let go and missed
/// alike. The holes are the interesting part, so they come back too.
#[tauri::command]
fn plan_timeline(db: State<Db>, id: String) -> R<Vec<PlanOccurrence>> {
    with_db(&db, |c| plans::plan_timeline(c, &id))
}

/// Says these postings belong to this plan. Nothing counts for a plan until
/// it does — a plan never claims a payment on its own.
#[tauri::command]
fn link_plan_postings(db: State<Db>, plan_id: String, ids: Vec<String>) -> R<i64> {
    with_db(&db, |c| plans::link_postings(c, &plan_id, &ids))
}

/// Takes a posting back off a plan. The posting itself is untouched.
#[tauri::command]
fn unlink_plan_posting(db: State<Db>, plan_id: String, transaction_id: String) -> R<()> {
    with_db(&db, |c| plans::unlink_posting(c, &plan_id, &transaction_id))
}

/// Which plan each of these postings already backs, keyed by posting id.
#[tauri::command]
fn plans_of_postings(
    db: State<Db>,
    ids: Vec<String>,
) -> R<std::collections::HashMap<String, String>> {
    with_db(&db, |c| plans::plans_of_postings(c, &ids))
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

/// One repayment laid over everything a person owes, oldest first.
#[tauri::command]
fn save_person_repayment(db: State<Db>, input: PersonRepaymentInput) -> R<String> {
    with_db(&db, |c| db::save_person_repayment(c, input))
}

#[tauri::command]
fn delete_person_repayment(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_person_repayment(c, &id))
}

/// More handed over against a debt already open.
#[tauri::command]
fn save_debt_addition(db: State<Db>, input: DebtAdditionInput) -> R<()> {
    with_db(&db, |c| db::save_debt_addition(c, input))
}

#[tauri::command]
fn delete_debt_addition(db: State<Db>, id: String) -> R<()> {
    with_db(&db, |c| db::delete_debt_addition(c, &id))
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

/// What one holding of yours has been worth, day by day — the units you held
/// at each day's price, rather than the scheme's own NAV line.
#[tauri::command]
fn holding_value_series(db: State<Db>, id: String, days: Option<i64>) -> R<Vec<ValuePoint>> {
    with_db(&db, |c| db::holding_value_series(c, &id, days))
}

/// The same, for every holding at once.
#[tauri::command]
fn holding_value_series_all(
    db: State<Db>,
    days: Option<i64>,
) -> R<std::collections::HashMap<String, Vec<ValuePoint>>> {
    with_db(&db, |c| db::holding_value_series_all(c, days))
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

/// What a gram of gold has gone for, day by day, at the fineness asked for —
/// the market behind every piece, rather than what any one locker holds.
#[tauri::command]
fn gold_rate_series(
    db: State<Db>,
    days: Option<i64>,
    purity_e4: Option<i64>,
) -> R<Vec<PricePoint>> {
    with_db(&db, |c| db::gold_rate_series(c, days, purity_e4))
}

/// What everything in the book has been worth, day by day, as one line.
#[tauri::command]
fn portfolio_value_series(db: State<Db>, days: Option<i64>) -> R<Vec<ValuePoint>> {
    with_db(&db, |c| db::portfolio_value_series(c, days))
}

/// The same, for one sleeve of it: funds, gold or deposits.
#[tauri::command]
fn sleeve_value_series(
    db: State<Db>,
    days: Option<i64>,
    sleeve: String,
) -> R<Vec<ValuePoint>> {
    with_db(&db, |c| db::sleeve_value_series(c, days, Some(&sleeve)))
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
///
/// "Beside it" means beside the book being replaced, not beside the file
/// being read. A picked file is somewhere we were handed rather than
/// somewhere we own — on iOS it arrives as a security-scoped URL into another
/// app's storage, which generally cannot be written next to at all, and even
/// on the Mac it may be a read-only volume or a download folder that gets
/// swept. The book's own directory is ours on every platform, and it is where
/// somebody looking for what they just overwrote would think to look.
#[tauri::command]
fn import_book(db: State<Db>, from: String) -> R<String> {
    let source = std::path::PathBuf::from(&from);
    let name = format!(
        "midas-replaced-{}.sqlite3",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let backup = with_db(&db, |c| {
        // The live connection knows where it was opened from; falling back on
        // the source's own directory keeps the old behaviour for the case
        // where it somehow does not.
        let beside = c.path().map(std::path::PathBuf::from).unwrap_or(source.clone());
        let backup = beside.with_file_name(&name);
        db::import_book(c, &source, &backup)?;
        let _ = capture::write_book(c);
        Ok(backup)
    })?;
    Ok(backup.to_string_lossy().into_owned())
}

#[tauri::command]
fn reset_all(db: State<Db>) -> R<()> {
    with_db(&db, |c| {
        db::reset(c)?;
        let _ = capture::write_book(c);
        Ok(())
    })
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
            let book = dir.join("midas.sqlite3");
            let conn = db::open(&book).map_err(std::io::Error::other)?;
            // Cycles that closed while the app was shut are credited now.
            cashback::settle(&conn).map_err(std::io::Error::other)?;

            // A brand-new book gets sample data once, so the first launch has
            // something to show. Wiping from Settings sets the flag and sticks.
            let seeded = db::setting(&conn, "seeded").map_err(std::io::Error::other)?;
            if seeded.is_none() && !db::has_any_data(&conn).map_err(std::io::Error::other)? {
                demo::seed(&conn).map_err(std::io::Error::other)?;
                db::set_setting(&conn, "seeded", "1").map_err(std::io::Error::other)?;
            }

            // The phone reads this book's accounts and categories out of a
            // file beside the drop. Written at launch as well as on every
            // change, so a fresh install has one before the first sentence.
            let _ = capture::write_book(&conn);

            app.manage(Db(Mutex::new(conn)));
            app.manage(chat::BookPath(book));
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
            reorder_categories,
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
            cards,
            card_terms,
            cashback_quote,
            save_card_term,
            delete_card_term,
            tax_year,
            tax_years,
            tax_map,
            set_tax_tag,
            tax_export,
            parse_statement,
            preview_statement_import,
            commit_statement_import,
            ai_status,
            ai_save_key,
            ai_forget_key,
            ai_test,
            ai_read_statements,
            ai_chat,
            ai_chat_stop,
            list_labels,
            label_transactions,
            save_label,
            delete_label,
            list_folders,
            save_folder,
            delete_folder,
            add_to_folder,
            remove_from_folder,
            confirm_triage,
            sync_captures,
            list_captures,
            capture_history,
            known_merchants,
            post_capture,
            dismiss_capture,
            capture_paths,
            list_templates,
            save_template,
            delete_template,
            use_template,
            list_plans,
            save_plan,
            delete_plan,
            set_plan_archived,
            skip_plan,
            pay_plan,
            plan_calendar,
            plan_timeline,
            link_plan_postings,
            unlink_plan_posting,
            plans_of_postings,
            list_debts,
            save_debt,
            delete_debt,
            debt_entries,
            save_debt_payment,
            delete_debt_payment,
            save_person_repayment,
            delete_person_repayment,
            save_debt_addition,
            delete_debt_addition,
            list_holdings,
            save_holding,
            delete_holding,
            save_investment_lot,
            delete_investment_lot,
            refresh_prices,
            holding_series,
            holding_value_series,
            holding_value_series_all,
            holding_series_all,
            gold_value_series,
            gold_rate_series,
            portfolio_value_series,
            sleeve_value_series,
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
