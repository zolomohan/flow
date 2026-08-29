use serde::{Deserialize, Serialize};

/// All monetary values are stored and transported as integer **paise**
/// (1 rupee = 100 paise) so that arithmetic is exact.
pub type Paise = i64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    /// bank | cash | credit | wallet | investment
    pub kind: String,
    pub institution: Option<String>,
    pub opening_balance: Paise,
    pub color: String,
    pub icon: String,
    pub archived: bool,
    pub sort_order: i64,
    pub created_at: String,
    /// Credit limit for a card, in paise. Zero means "not tracked".
    pub credit_limit: Paise,
    /// Derived: opening balance folded with every posting that touches it.
    pub balance: Paise,
    /// Derived: what the holdings parked in this account are worth today, less
    /// the basis their own postings already put on `balance`. Add it to
    /// `balance` for what the account is actually worth. Zero everywhere no
    /// holding sits — and the whole market value of gold, which is weighed
    /// rather than bought and so posts nothing to the ledger at all.
    pub revaluation: Paise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub institution: Option<String>,
    pub opening_balance: Paise,
    pub color: String,
    pub icon: String,
    pub credit_limit: Paise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    /// income | expense
    pub kind: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub sort_order: i64,
    /// `None` for a top-level group. Categories nest exactly one level:
    /// a parent may hold transactions of its own as well as children.
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    /// income | expense | transfer
    pub kind: String,
    pub amount: Paise,
    pub account_id: String,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub merchant: String,
    pub note: Option<String>,
    /// ISO-8601 local datetime, e.g. 2026-08-29T14:05
    pub occurred_at: String,
    pub created_at: String,
    // Denormalised for rendering without a second round-trip.
    pub account_name: String,
    pub account_color: String,
    pub to_account_name: Option<String>,
    pub category_name: Option<String>,
    pub category_icon: Option<String>,
    pub category_color: Option<String>,
    pub category_group_id: Option<String>,
    pub category_group_name: Option<String>,
    /// The line items this posting was split into. Empty for the ordinary
    /// case: one bill, one category. When it is not, the parts add up to
    /// `amount` exactly, so the ledger still sees a single posting.
    pub splits: Vec<TransactionSplit>,
    /// Who else was in on this bill. Each one is a debt of its own, opened by
    /// this posting and repaid on the Debts screen like any other.
    pub shares: Vec<TransactionShare>,
}

/// One line of a split bill: part of the money, filed on its own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSplit {
    pub id: String,
    pub transaction_id: String,
    pub amount: Paise,
    pub category_id: Option<String>,
    pub note: Option<String>,
    pub sort_order: i64,
    // Denormalised, exactly as on the posting itself.
    pub category_name: Option<String>,
    pub category_icon: Option<String>,
    pub category_color: Option<String>,
    pub category_group_id: Option<String>,
    pub category_group_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSplitInput {
    pub id: Option<String>,
    pub amount: Paise,
    pub category_id: Option<String>,
    pub note: Option<String>,
}

/// One person's share of a split bill — a debt, seen from the posting that
/// opened it, so a form can show who owes what without loading every debt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionShare {
    pub debt_id: String,
    /// lent = they owe you · borrowed = you owe them
    pub direction: String,
    pub counterparty: String,
    pub amount: Paise,
    pub due_on: Option<String>,
    pub note: Option<String>,
    pub paid: Paise,
    pub outstanding: Paise,
    pub settled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionShareInput {
    /// The debt this share already is, when the split is being edited.
    pub id: Option<String>,
    pub direction: String,
    pub counterparty: String,
    pub amount: Paise,
    pub due_on: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionInput {
    pub id: Option<String>,
    pub kind: String,
    pub amount: Paise,
    pub account_id: String,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub merchant: String,
    pub note: Option<String>,
    pub occurred_at: String,
    /// Line items to file this posting under. `None` leaves whatever is
    /// already there alone; an empty list clears it back to one category.
    pub splits: Option<Vec<TransactionSplitInput>>,
    /// Who owes what out of this bill. Same rule: `None` changes nothing,
    /// empty clears every share the split opened.
    pub shares: Option<Vec<TransactionShareInput>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionQuery {
    pub search: Option<String>,
    pub kinds: Option<Vec<String>>,
    pub account_ids: Option<Vec<String>>,
    /// Which side of a posting the accounts have to be on: `from` for money
    /// leaving them, `to` for money arriving. Anything else means either, which
    /// is the only sensible default for income and expenses.
    pub account_side: Option<String>,
    pub category_ids: Option<Vec<String>>,
    /// Inclusive ISO date bounds (YYYY-MM-DD).
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
    /// Rows to skip, for paging a long ledger.
    pub offset: Option<i64>,
}

/// What a filtered ledger comes to, independent of how much of it is on screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionSummary {
    pub count: i64,
    pub income: Paise,
    pub expense: Paise,
    pub transferred: Paise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySlice {
    pub category_id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub total: Paise,
    pub count: i64,
    /// Leaf categories rolled into this group, largest first. Empty when the
    /// group has no children of its own.
    pub children: Vec<CategorySlice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowPoint {
    /// YYYY-MM for month buckets, YYYY-MM-DD for day buckets.
    pub bucket: String,
    pub income: Paise,
    pub expense: Paise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MerchantSlice {
    pub merchant: String,
    pub total: Paise,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The last month of the window this overview describes, as YYYY-MM.
    pub month: String,
    /// How many months the window covers, counting back from `month`.
    pub span: u32,
    /// Accounts plus what you are owed, minus what you owe.
    pub net_worth: Paise,
    pub liquid: Paise,
    /// Negative account balances (card outstanding) plus borrowed debt.
    pub debt: Paise,
    pub lent_outstanding: Paise,
    pub borrowed_outstanding: Paise,
    /// What the holdings on the Investments screen are worth today.
    pub investments: Paise,
    pub income: Paise,
    pub expense: Paise,
    pub prev_income: Paise,
    pub prev_expense: Paise,
    /// Running balance at the end of each day of the window, for the hero sparkline.
    pub balance_series: Vec<Paise>,
    pub daily_flow: Vec<FlowPoint>,
    pub monthly_flow: Vec<FlowPoint>,
    pub top_categories: Vec<CategorySlice>,
    pub top_merchants: Vec<MerchantSlice>,
}

// --------------------------------------------------------------------- debts

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPayment {
    pub id: String,
    pub debt_id: String,
    pub amount: Paise,
    pub occurred_at: String,
    pub note: Option<String>,
    /// The posting this repayment corresponds to, when there is one.
    pub transaction_id: Option<String>,
    pub transaction_label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPaymentInput {
    pub id: Option<String>,
    pub debt_id: String,
    pub amount: Paise,
    pub occurred_at: String,
    pub note: Option<String>,
    pub transaction_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Debt {
    pub id: String,
    /// lent = they owe you · borrowed = you owe them
    pub direction: String,
    pub counterparty: String,
    pub principal: Paise,
    pub opened_on: String,
    pub due_on: Option<String>,
    pub note: Option<String>,
    pub settled_at: Option<String>,
    pub created_at: String,
    /// The posting that opened this debt, when it came from one.
    pub transaction_id: Option<String>,
    pub transaction_label: Option<String>,
    /// True when this debt is one person's share of a split bill, rather than
    /// something entered on its own. Re-splitting that bill owns it.
    pub from_split: bool,
    // Derived.
    pub paid: Paise,
    pub outstanding: Paise,
    pub settled: bool,
    pub payments: Vec<DebtPayment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtInput {
    pub id: Option<String>,
    pub direction: String,
    pub counterparty: String,
    pub principal: Paise,
    pub opened_on: String,
    pub due_on: Option<String>,
    pub note: Option<String>,
    pub transaction_id: Option<String>,
    /// Explicitly mark as settled regardless of what has been repaid.
    pub settled: Option<bool>,
}

// ------------------------------------------------------------- investments

/// Grams, fund units and per-unit prices are stored as integers scaled by
/// 10^4, so that quantities stay exact in the same way `Paise` keeps money
/// exact. A `_e4` suffix always means "this value times ten thousand".
pub type Scaled = i64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentLot {
    pub id: String,
    pub holding_id: String,
    /// buy | sell
    pub kind: String,
    /// Grams or units, scaled by 10^4.
    pub quantity_e4: Scaled,
    /// What was paid or received. Zero for inherited or bonus units.
    pub amount: Paise,
    /// ISO date (YYYY-MM-DD) the money moved.
    pub occurred_at: String,
    /// ISO date the units were credited, when that was a different day —
    /// an SIP is debited on one date and allotted at another day's NAV.
    /// `None` means the units landed the day the money moved.
    pub allotted_at: Option<String>,
    /// The transfer this lot posted, when it posted one.
    pub transaction_id: Option<String>,
    pub transaction_label: Option<String>,
    /// The other side of that transfer — where the money came from on a buy,
    /// or went to on a sale. Read back off the posting so the form can be
    /// reopened showing what actually happened.
    pub cash_account_id: Option<String>,
    /// Whether this lot wrote that posting itself. A record you linked is
    /// yours and outlives the lot; one the lot created goes with it.
    pub owns_transaction: bool,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentLotInput {
    pub id: Option<String>,
    pub holding_id: String,
    pub kind: String,
    pub quantity_e4: Scaled,
    pub amount: Paise,
    /// When the money moved. This is the date the ledger posting carries.
    pub occurred_at: String,
    /// When the units were credited, if that was another day. The unit price
    /// belongs to this date, not to the one the cash left on.
    pub allotted_at: Option<String>,
    pub note: Option<String>,
    /// Where the money came from, or went to. Set it and the lot posts a
    /// transfer against the holding's account; leave it empty and the lot is
    /// recorded without touching the ledger, for anything bought before Midas.
    pub cash_account_id: Option<String>,
    /// A posting already in the book that this lot describes — the SIP
    /// transfer you have been recording by hand for months. Exclusive with
    /// `cash_account_id`: the lot either writes a transfer or points at one.
    pub transaction_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub id: String,
    /// gold | fund
    pub kind: String,
    pub name: String,
    /// The investment account purchases post into.
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    /// AMFI scheme code, for funds.
    pub scheme_code: Option<String>,
    pub isin: Option<String>,
    /// Gold purity scaled by 10^4: 10000 is 24K, 9160 is 22K, 7500 is 18K.
    pub purity_e4: Option<Scaled>,
    pub note: Option<String>,
    pub closed_at: Option<String>,
    pub created_at: String,
    // Derived.
    /// Grams or units held, scaled by 10^4. Gold carries the grams you typed;
    /// a fund carries what its lots add up to.
    pub units_e4: Scaled,
    /// What every buy cost, and what every sale returned. Both are zero for
    /// gold, which is an object you own rather than a position you traded.
    pub invested: Paise,
    pub realised: Paise,
    /// Rupees per gram or per unit, scaled by 10^4. `None` when nothing has
    /// been fetched yet — the screen says so rather than showing a zero.
    pub price_e4: Option<Scaled>,
    pub price_as_of: Option<String>,
    pub market_value: Paise,
    /// What the position has made: value today, plus proceeds, less cost.
    /// Zero for gold — with no cost recorded there is nothing to measure against.
    pub total_return: Paise,
    pub closed: bool,
    pub lots: Vec<InvestmentLot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingInput {
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub account_id: Option<String>,
    pub scheme_code: Option<String>,
    pub isin: Option<String>,
    pub purity_e4: Option<Scaled>,
    /// How much gold you hold, in grams scaled by 10^4. Gold is weighed, not
    /// traded: this is the whole of it, and it is ignored for a fund.
    pub grams_e4: Option<Scaled>,
    pub note: Option<String>,
    /// Explicitly close or reopen the position.
    pub closed: Option<bool>,
}

/// A mutual fund scheme as AMFI names it, for the search-and-pick field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheme {
    pub scheme_code: String,
    pub scheme_name: String,
}
