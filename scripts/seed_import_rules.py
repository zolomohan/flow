#!/usr/bin/env python3
"""
Seed Midas's import_rules from history, so the first statement import arrives
mostly classified.

    python3 scripts/seed_import_rules.py "~/Downloads/HDFC 2.xls" "~/Downloads/HDFC 1.xls" --account HDFC [--dry-run]

For every statement row that pairs with a posting already in the book (same
amount, same side, dates within five days), the posting's filing — kind,
category, transfer counterpart, merchant — is written down against the
narration's match key. Rules land *unconfirmed*: their suggestions prefill the
import preview but still wear the Triage label until confirmed in the app,
at which point the app rewrites them as confirmed.

The key derivation mirrors `src-tauri/src/import.rs::match_key` and must be
kept in step with it — a drifted key simply stops suggesting, it never
mis-files, but it wastes the memory.

Close the Midas app first — this writes to the SQLite book directly.
"""

import argparse
import collections
import datetime as dt
import os
import sqlite3
import sys
import uuid

try:
    import xlrd
except ImportError:
    sys.exit("pip install xlrd — it reads the legacy .xls files banks export.")

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.mohanraj.midas/midas.sqlite3"
)

# ----------------------------------------------------------- match keys
# A line-for-line mirror of import.rs::match_key.


def looks_like_ifsc(seg: str) -> bool:
    return (
        len(seg) == 11
        and seg[:4].isalpha()
        and seg[4] == "0"
        and seg[5:].isalnum()
    )


def ach_name(upper: str) -> str:
    after = upper[3:].lstrip()
    if after[:1] in ("D", "C") and after[1:2] in ("-", " "):
        after = after[1:].lstrip("- ")
    return " ".join(
        tok for tok in after.split("-")[0].split() if not any(c.isdigit() for c in tok)
    )


def pos_merchant(upper: str) -> str:
    return " ".join(
        tok for tok in upper.split()[1:] if not any(c.isdigit() for c in tok)
    )


def counterparty_segment(upper: str):
    for seg in [s.strip() for s in upper.split("-")[1:]]:
        letters = sum(c.isalpha() for c in seg)
        digits = sum(c.isdigit() for c in seg)
        if letters >= 3 and digits <= letters and not looks_like_ifsc(seg):
            return seg
    return None


def match_key(narration: str):
    n = narration.strip()
    if not n:
        return None
    upper = n.upper()

    if upper.startswith("UPI-"):
        segments = upper[4:].split("-")
        for seg in segments:
            if "@" in seg:
                return f"upi:{seg.strip().lower()}"
        if segments and segments[0].strip():
            return f"upi:{segments[0].strip().lower()}"
        return None

    if upper.startswith("ACH"):
        name = ach_name(upper)
        if name:
            return f"ach:{name.lower()}"

    if "DC INTL POS TXN MARKUP" in upper:
        return "fee:dc-intl-pos-markup"

    for mode in ("NEFT", "RTGS", "IMPS"):
        if upper.startswith(mode) or upper.startswith(f".{mode}"):
            name = counterparty_segment(upper)
            if name:
                return f"{mode.lower()}:{name.lower()}"

    if upper.startswith("POS ") or upper.startswith(".POS "):
        merchant = pos_merchant(upper)
        if merchant:
            return f"pos:{merchant.lower()}"

    letters = "".join(c if (c.isascii() and c.isalpha()) or c == " " else " " for c in upper)
    squeezed = " ".join(letters.split())
    if not squeezed:
        return None
    return f"misc:{squeezed.lower()[:48].rstrip()}"


# ----------------------------------------------------------- statements


def load_statement(path):
    rows = []
    wb = xlrd.open_workbook(path)
    sh = wb.sheet_by_index(0)
    for r in range(sh.nrows):
        vals = [c.value for c in sh.row(r)]
        d = str(vals[0]).strip()
        parts = d.split("/")
        if len(parts) != 3 or not all(p.isdigit() for p in parts):
            continue
        date = dt.date(2000 + int(parts[2]), int(parts[1]), int(parts[0]))
        wd = str(vals[4]).strip()
        dep = str(vals[5]).strip()
        if wd:
            amount, direction = round(float(wd) * 100), "debit"
        elif dep:
            amount, direction = round(float(dep) * 100), "credit"
        else:
            continue
        rows.append(
            {"date": date, "narration": str(vals[1]).strip(), "amount": amount, "dir": direction}
        )
    return rows


# ------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("statements", nargs="+", help="statement .xls files")
    ap.add_argument("--account", default="HDFC", help="account name in Midas")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    # The same DDL the app's migration runs, so seeding can happen before the
    # new build has ever been launched.
    con.execute(
        """CREATE TABLE IF NOT EXISTS import_rules (
               id              TEXT PRIMARY KEY,
               match_key       TEXT NOT NULL UNIQUE,
               kind            TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
               category_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
               from_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
               to_account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
               merchant        TEXT NOT NULL DEFAULT '',
               confirmed       INTEGER NOT NULL DEFAULT 0,
               updated_at      TEXT NOT NULL
           )"""
    )
    account = con.execute(
        "SELECT id FROM accounts WHERE name = ?", (args.account,)
    ).fetchone()
    if not account:
        sys.exit(f"No account named {args.account!r} in the book.")
    acc = account["id"]

    stmt = []
    for path in args.statements:
        stmt.extend(load_statement(path))
    lo = min(s["date"] for s in stmt) - dt.timedelta(days=6)
    hi = max(s["date"] for s in stmt) + dt.timedelta(days=6)

    txs = []
    for t in con.execute(
        """SELECT id, kind, amount, account_id, to_account_id, category_id, merchant,
                  occurred_at
           FROM transactions
           WHERE (account_id = ? OR to_account_id = ?)
             AND occurred_at >= ? AND occurred_at <= ?""",
        (acc, acc, lo.isoformat(), hi.isoformat() + "T23:59:59"),
    ):
        if t["kind"] == "expense":
            d = "debit"
        elif t["kind"] == "income":
            d = "credit"
        else:
            d = "debit" if t["account_id"] == acc else "credit"
        txs.append(dict(t) | {"dir": d, "date": dt.date.fromisoformat(t["occurred_at"][:10])})

    # Same nearest-date greedy pairing the app's preview uses.
    free = list(txs)
    pairs = []
    for window in (0, 1, 3, 5):
        for s in stmt:
            if s.get("hit"):
                continue
            best = None
            for t in free:
                if t["amount"] != s["amount"] or t["dir"] != s["dir"]:
                    continue
                delta = abs((t["date"] - s["date"]).days)
                if delta <= window and (best is None or delta < best[0]):
                    best = (delta, t)
            if best:
                s["hit"] = True
                free.remove(best[1])
                pairs.append((s, best[1]))

    # One vote per pairing; the commonest filing per key wins.
    votes = collections.defaultdict(collections.Counter)
    merchants = collections.defaultdict(collections.Counter)
    for s, t in pairs:
        key = match_key(s["narration"])
        if not key:
            continue
        if t["kind"] == "transfer":
            filing = ("transfer", None, t["account_id"], t["to_account_id"])
        else:
            filing = (t["kind"], t["category_id"], None, None)
        votes[key][filing] += 1
        if t["merchant"]:
            merchants[key][t["merchant"]] += 1

    existing = {
        r["match_key"] for r in con.execute("SELECT match_key FROM import_rules")
    }
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    written = skipped = 0
    for key, counter in sorted(votes.items()):
        if key in existing:
            skipped += 1
            continue
        (kind, category_id, from_acc, to_acc), n = counter.most_common(1)[0]
        merchant = merchants[key].most_common(1)[0][0] if merchants[key] else ""
        print(f"  {key:52} → {kind:8} ({n} vote{'s' if n > 1 else ''})  {merchant}")
        if not args.dry_run:
            con.execute(
                """INSERT INTO import_rules
                       (id, match_key, kind, category_id, from_account_id,
                        to_account_id, merchant, confirmed, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)""",
                (str(uuid.uuid4()), key, kind, category_id, from_acc, to_acc, merchant, now),
            )
        written += 1

    if not args.dry_run:
        con.commit()
    print(
        f"\n{len(pairs)} matched pairs → {written} rules"
        f"{' (dry run, nothing written)' if args.dry_run else ''}"
        + (f" · {skipped} keys already known" if skipped else "")
    )


if __name__ == "__main__":
    main()
