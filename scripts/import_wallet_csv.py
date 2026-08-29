#!/usr/bin/env python3
"""
Import a Wallet (BudgetBakers) CSV export into Midas.

    python3 scripts/import_wallet_csv.py ~/Downloads/wallet_records.csv [--keep]

Close the Midas app first — this writes to the SQLite book directly.

Notes on the mapping:
  * Amounts are stored as integer paise. Rows already in INR use `amount`;
    foreign-currency rows use `ref_currency_amount`, which carries the
    converted INR figure.
  * Wallet writes a transfer as two rows (one Expense leg, one Income leg).
    Legs that pair on (timestamp, amount) become a single Midas transfer.
    Legs whose counterpart is missing from the export become a transfer
    against a placeholder account, so they stay out of income/spend totals.
  * Wallet's flat category list is rebuilt as one level of groups and
    sub-categories; every original category survives as a leaf.
  * Timestamps in the export are UTC; they are converted to local wall time,
    which is what Midas stores.
"""

import argparse
import collections
import csv
import datetime as dt
import os
import sqlite3
import sys
import uuid

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.mohanraj.midas/midas.sqlite3"
)

PLACEHOLDER_ACCOUNT = "Unlinked"

# ---------------------------------------------------------------- accounts

# The export carries records only — never the initial amount you set when the
# account was created — so opening balances live here. `opening` is in rupees
# and may be negative; `limit` is the credit limit, cards only.
#
# name -> (kind, colour, icon, archived, opening, limit)
ACCOUNTS = {
    "Indian":         ("bank",       "#20294C", "landmark",      0,  870_421,       0),
    "HDFC":           ("bank",       "#118AE4", "landmark",      0, -200_045,       0),
    "ICICI":          ("credit",     "#F2724F", "credit-card",   0,        0, 330_000),
    "Federal":        ("bank",       "#0F9D58", "building-2",    0,    8_114,       0),
    "Wallet":         ("cash",       "#42C251", "wallet",        0,   -1_967,       0),
    # The two cards were set up differently in Wallet, so their openings are
    # not derived the same way — each is whatever reproduces the outstanding
    # balance the card actually carries:
    #   ICICI  — initial was set to the full 3,30,000 limit, so Wallet's
    #            balance for it reads as *available credit*. Nothing was owed
    #            at setup, hence an opening of zero here.
    #   Swiggy — initial was 44,794 and is not the limit, so Wallet's balance
    #            for it already reads as the (negative) liability. Used as-is.
    "Swiggy":         ("credit",     "#F0B429", "credit-card",   0,   44_794, 500_000),
    "Swiggy Archive": ("wallet",     "#979DB5", "smartphone",    1,        0,       0),
    "Amazon":         ("wallet",     "#A855F7", "smartphone",    0,       10,       0),
    "Starbucks":      ("wallet",     "#054D4D", "smartphone",    0,      800,       0),
    "THB":            ("cash",       "#06B6D4", "banknote",      0,        0,       0),
    "Silver MF":      ("investment", "#7C3AED", "trending-up",   0,        0,       0),
    # Stands in for transfer legs whose counterpart is missing from the
    # export. Archived, so it never counts toward net worth.
    PLACEHOLDER_ACCOUNT: ("wallet",  "#676B89", "circle-dashed", 1,        0,       0),
}

# ------------------------------------------------------------- categories

# group name -> (icon, colour, [Wallet categories filed under it])
# A group listed as its own child holds those transactions directly.
EXPENSE_TREE = [
    ("Food & Drink",     "utensils",        "#F2724F",
     ["Restaurant", "Snacks", "Coffee", "Drinks", "Food & Drinks"]),
    ("Groceries",        "shopping-basket", "#42C251", ["Groceries"]),
    ("Transport",        "car-front",       "#118AE4",
     ["Taxi", "Fuel", "Public transport", "Parking", "Long distance",
      "Vehicle", "Vehicle maintenance", "Vehicle insurance"]),
    ("Shopping",         "shopping-bag",    "#A855F7",
     ["Shopping", "Clothes", "Electronics", "Accessories", "Stationery", "Books"]),
    ("Bills & Utilities", "zap",            "#F0B429",
     ["Internet", "Phone", "Energy, utilities", "Services", "Charges, Fees",
      "Tech & Internet"]),
    ("Rent & Home",      "house",           "#5A87E6",
     ["Rent", "Home", "Housing", "Maintenance, repairs", "Rentals"]),
    ("Health",           "heart-pulse",     "#EC4899",
     ["Health", "Drugstore", "Medical", "Health and beauty", "Fitness"]),
    ("Entertainment",    "clapperboard",    "#8B5CF6",
     ["Movies", "Games", "Software, apps, games", "Fun", "Events",
      "Culture, sport events", "Hobbies", "Leisure time", "Diving",
      "Books, audio, subscriptions"]),
    ("Travel",           "plane",           "#06B6D4",
     ["Travel", "Vacation", "Business trips"]),
    ("Education",        "graduation-cap",  "#0EA5E9", ["Education"]),
    ("Subscriptions",    "repeat",          "#14B8A6", ["Subscriptions"]),
    ("Family & Gifts",   "gift",            "#F43F5E",
     ["Family Support", "Friends & Family", "Charity, gifts", "Gifts", "Life"]),
    ("Loans & Interest", "coins",           "#7C3AED", ["Loans, interests"]),
    ("Financial",        "receipt",         "#94A3B8",
     ["Financial expenses", "Taxes", "Fines", "Insurances", "Investments", "Gold"]),
    ("Adjustments",      "undo-2",          "#979DB5", ["Adjustment", "Refunds"]),
    ("Other",            "circle-dashed",   "#676B89",
     ["Others", "Other", "Track", "Income"]),
]

INCOME_TREE = [
    ("Salary & Wages",    "briefcase",     "#42C251", ["Wage, invoices", "Income"]),
    ("Lending & Renting", "coins",         "#0F9D58", ["Lending, renting"]),
    ("Interest & Sales",  "trending-up",   "#118AE4", ["Interests", "Sale"]),
    ("Refunds & Rewards", "undo-2",        "#F0B429", ["Refunds", "Rewards"]),
    ("Gifts",             "gift",          "#F43F5E", ["Gifts"]),
    ("Adjustments",       "circle-dashed", "#979DB5", ["Adjustment"]),
    ("Other Income",      "circle-dashed", "#676B89",
     ["Others", "Other", "Loans, interests", "Financial expenses", "Restaurant"]),
]

# Leaves get their group's colour, but their own glyph where one fits.
LEAF_ICONS = {
    "Restaurant": "utensils", "Snacks": "shopping-basket", "Coffee": "coffee",
    "Drinks": "utensils", "Food & Drinks": "utensils",
    "Taxi": "car-front", "Fuel": "zap", "Public transport": "car-front",
    "Parking": "car-front", "Long distance": "plane", "Vehicle": "car-front",
    "Vehicle maintenance": "car-front", "Vehicle insurance": "receipt",
    "Clothes": "shopping-bag", "Electronics": "smartphone",
    "Accessories": "shopping-bag", "Stationery": "pencil", "Books": "graduation-cap",
    "Internet": "zap", "Phone": "smartphone", "Energy, utilities": "zap",
    "Services": "receipt", "Charges, Fees": "receipt", "Tech & Internet": "zap",
    "Rent": "house", "Home": "house", "Housing": "house",
    "Maintenance, repairs": "house", "Rentals": "house",
    "Drugstore": "heart-pulse", "Medical": "heart-pulse",
    "Health and beauty": "heart-pulse", "Fitness": "heart-pulse",
    "Movies": "clapperboard", "Games": "clapperboard",
    "Software, apps, games": "clapperboard", "Fun": "sparkles",
    "Events": "clapperboard", "Culture, sport events": "clapperboard",
    "Hobbies": "sparkles", "Leisure time": "sparkles", "Diving": "sparkles",
    "Books, audio, subscriptions": "repeat",
    "Vacation": "plane", "Business trips": "briefcase",
    "Family Support": "gift", "Friends & Family": "gift",
    "Charity, gifts": "gift", "Life": "gift",
    "Financial expenses": "receipt", "Taxes": "receipt", "Fines": "receipt",
    "Insurances": "receipt", "Investments": "trending-up", "Gold": "coins",
    "Wage, invoices": "briefcase", "Lending, renting": "coins",
    "Interests": "piggy-bank", "Sale": "store", "Rewards": "sparkles",
    "Loans, interests": "coins",
}

TRANSFER_CATEGORY = "Transfer, withdraw"


def new_id():
    return str(uuid.uuid4())


def to_local(iso: str) -> str:
    """UTC timestamp from the export -> local `YYYY-MM-DDTHH:MM`."""
    stamp = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return stamp.astimezone().strftime("%Y-%m-%dT%H:%M")


def inr_paise(row) -> int:
    """
    The INR value of a row, in paise.

    `amount` is authoritative for rows already in INR — `ref_currency_amount`
    is 0 on a handful of transfer legs, and on one cross-currency leg it
    carries the *other* side's converted value. For a foreign-currency row
    `ref_currency_amount` is the only INR figure available.
    """
    source = row["amount"] if row["currency"] == "INR" else row["ref_currency_amount"]
    return int(round(float(source) * 100))


def build_note(row) -> str | None:
    parts = [row["note"].strip(), row["labels"].strip()]
    joined = " · ".join(p for p in parts if p)
    return joined or None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--keep", action="store_true",
                    help="keep whatever is already in the book (default wipes it)")
    ap.add_argument("--from", dest="since", metavar="YYYY-MM-DD",
                    help="skip records before this date (opening balances then "
                         "need to be the balances as at that date)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.csv_path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh, delimiter=";"))
    print(f"read {len(rows)} records from {args.csv_path}")
    if args.since:
        before = len(rows)
        rows = [r for r in rows if to_local(r["date"])[:10] >= args.since]
        print(f"kept {len(rows)} on or after {args.since} ({before - len(rows)} dropped)")

    # --- verify every category in the file has a home ---------------------
    tree = {"expense": EXPENSE_TREE, "income": INCOME_TREE}
    mapped = {
        kind: {leaf for _, _, _, leaves in branches for leaf in leaves}
        for kind, branches in tree.items()
    }
    missing = collections.defaultdict(set)
    for row in rows:
        if row["transfer"] == "true" or row["category"] == TRANSFER_CATEGORY:
            continue
        kind = row["type"].lower()
        if row["category"] not in mapped.get(kind, ()):
            missing[kind].add(row["category"])
    if missing:
        for kind, names in missing.items():
            print(f"  !! unmapped {kind} categories: {sorted(names)}", file=sys.stderr)
        return 1
    print(f"categories: all {sum(len(v) for v in mapped.values())} mapped")

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys = ON")

    # `executescript` commits whatever is pending, so a dry run must never
    # reach it — otherwise the wipe would stick despite the rollback below.
    if not args.keep and not args.dry_run:
        conn.executescript(
            "DELETE FROM transactions; DELETE FROM accounts; DELETE FROM categories;"
        )
        print("cleared the existing book")

    now = dt.datetime.now(dt.timezone.utc).isoformat()

    # --- accounts ---------------------------------------------------------
    used = {r["account"] for r in rows} | {PLACEHOLDER_ACCOUNT}
    account_id = {}
    for order, name in enumerate(a for a in ACCOUNTS if a in used):
        kind, color, icon, archived, opening, limit = ACCOUNTS[name]
        account_id[name] = new_id()
        conn.execute(
            """INSERT INTO accounts (id, name, kind, institution, opening_balance,
                                     color, icon, archived, sort_order, created_at,
                                     credit_limit)
               VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)""",
            (account_id[name], name, kind, opening * 100, color, icon, archived,
             order, now, limit * 100),
        )
    print(f"accounts: {len(account_id)}")

    # --- categories -------------------------------------------------------
    cat_id = {}          # (kind, wallet category name) -> leaf id
    groups_made = leaves_made = 0
    for kind, branches in tree.items():
        for order, (group, icon, color, leaves) in enumerate(branches):
            gid = new_id()
            conn.execute(
                """INSERT INTO categories (id, kind, name, icon, color, sort_order, parent_id)
                   VALUES (?, ?, ?, ?, ?, ?, NULL)""",
                (gid, kind, group, icon, color, order),
            )
            groups_made += 1
            for child_order, leaf in enumerate(leaves):
                if leaf == group:
                    # The group carries these rows itself; no child needed.
                    cat_id[(kind, leaf)] = gid
                    continue
                lid = new_id()
                conn.execute(
                    """INSERT INTO categories (id, kind, name, icon, color, sort_order, parent_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (lid, kind, leaf, LEAF_ICONS.get(leaf, icon), color, child_order, gid),
                )
                cat_id[(kind, leaf)] = lid
                leaves_made += 1
    print(f"categories: {groups_made} groups, {leaves_made} sub-categories")

    # --- pair up transfer legs -------------------------------------------
    legs = [r for r in rows if r["transfer"] == "true"]
    plain = [r for r in rows if r["transfer"] != "true"]

    buckets = collections.defaultdict(list)
    for row in legs:
        buckets[(row["date"], row["amount"])].append(row)

    pairs, orphans = [], []
    for bucket in buckets.values():
        outs = [r for r in bucket if r["type"] == "Expense"]
        ins = [r for r in bucket if r["type"] == "Income"]
        while outs and ins:
            src = outs.pop(0)
            # Prefer a counterpart on a different account.
            dst = next((r for r in ins if r["account"] != src["account"]), None)
            if dst is None:
                orphans.append(src)
                continue
            ins.remove(dst)
            pairs.append((src, dst))
        orphans.extend(outs)
        orphans.extend(ins)
    print(f"transfers: {len(pairs)} matched pairs, {len(orphans)} unmatched legs")

    zeroes = [r for r in rows if inr_paise(r) <= 0]
    if zeroes:
        print(f"  !! {len(zeroes)} rows have no positive INR value:", file=sys.stderr)
        for r in zeroes[:10]:
            print(f"     {r['date'][:19]} {r['account']} {r['type']} "
                  f"amount={r['amount']} ref={r['ref_currency_amount']}", file=sys.stderr)
        return 1

    tx = []

    for src, dst in pairs:
        tx.append((
            new_id(), "transfer", inr_paise(src),
            account_id[src["account"]], account_id[dst["account"]], None,
            src["note"].strip() or "Transfer", build_note(src),
            to_local(src["date"]), now,
        ))

    # An unmatched leg still moved money; the placeholder stands in for the
    # side the export did not carry, so it never reads as income or spending.
    for row in orphans:
        here = account_id[row["account"]]
        there = account_id[PLACEHOLDER_ACCOUNT]
        src, dst = (here, there) if row["type"] == "Expense" else (there, here)
        tx.append((
            new_id(), "transfer", inr_paise(row),
            src, dst, None,
            row["note"].strip() or "Transfer (unmatched)", build_note(row),
            to_local(row["date"]), now,
        ))

    for row in plain:
        kind = row["type"].lower()
        tx.append((
            new_id(), kind, inr_paise(row),
            account_id[row["account"]], None, cat_id[(kind, row["category"])],
            row["payee"].strip(), build_note(row),
            to_local(row["date"]), now,
        ))

    if args.dry_run:
        conn.rollback()
        print(f"dry run — would have written {len(tx)} transactions")
        return 0

    conn.executemany(
        """INSERT INTO transactions (id, kind, amount, account_id, to_account_id,
                                     category_id, merchant, note, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        tx,
    )
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('seeded', '1') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    conn.commit()

    counts = dict(conn.execute("SELECT kind, COUNT(*) FROM transactions GROUP BY kind"))
    print(f"\nwrote {len(tx)} transactions: {counts}")
    span = conn.execute("SELECT MIN(occurred_at), MAX(occurred_at) FROM transactions").fetchone()
    print(f"covering {span[0][:10]} to {span[1][:10]}")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
