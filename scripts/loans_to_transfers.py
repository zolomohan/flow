#!/usr/bin/env python3
"""Turn the lending ledger into transfers and debts.

Money you lent is not money you spent, and money that came back is not
income — but a book imported from elsewhere files both as ordinary postings,
so years of hand-offs between friends sit in the spending charts.

This moves them out of the ledger's two sides without moving a rupee:
every hand-off becomes a transfer against one account that stands for money
out with people, and each person's running total becomes a debt record,
settled, since what is still out is being forgiven rather than chased.

Read-only until it commits, backs the book up first, and refuses to run
twice. Nothing here is app behaviour — it is a one-off for a book that
predates the rule.
"""

from __future__ import annotations

import collections
import datetime as dt
import re
import sqlite3
import sys
import uuid
from pathlib import Path

BOOK = Path.home() / "Library/Application Support/com.mohanraj.midas/midas.sqlite3"
HOLDING = "Lent & borrowed"

# The categories the lending sits in, either side of the ledger.
CATEGORIES = ("Loans, interests", "Lending, renting")

# Interest and merchant credit are not hand-offs between people: they are
# what they say they are, and they stay where they are.
def is_not_a_handoff(merchant: str, note: str) -> bool:
    text = f"{merchant} {note}".lower()
    return (
        merchant in {"ICICI", "Amazon", "Mynta"}
        or "interest" in text and "→" not in note
        or "simpl" in text
    )

OUT = re.compile(r"^Me\s*→\s*([^:]+?)\s*(?::\s*(.*))?$")
IN = re.compile(r"^(.+?)\s*→\s*Me\s*(?::\s*(.*))?$")


def reason(note: str) -> str:
    """What a hand-off says it was for — the half after the colon."""
    hit = OUT.match(note.strip()) or IN.match(note.strip())
    return (hit.group(2) or "").strip() if hit else ""


def counterparty(merchant: str, note: str) -> str:
    """Who the money passed between, from whichever field says so."""
    for pattern in (OUT, IN):
        hit = pattern.match(note.strip())
        if hit:
            name = hit.group(1).strip()
            # "Suhruth Swiggy" is Suhruth, with the reason glued on.
            if merchant and name.lower().startswith(merchant.lower()):
                return merchant
            return name
    if merchant:
        return merchant
    # A note that names somebody without an arrow — "Mom's Debt".
    first = note.split("'")[0].split()[0] if note.strip() else ""
    return first or "Unidentified"


def rebuild_debts(conn: sqlite3.Connection, account_id: str, book: Path,
                  backed_up: bool = False) -> int:
    """Writes one debt per person from the transfers themselves.

    The principal is what the person who gave more actually handed over, the
    repayments are every movement the other way, and what never came back is
    left unpaid on a settled debt — which is what forgiving it looks like.
    Written from the ledger rather than from a running total, so a debt can
    be thrown away and worked out again.
    """
    if not backed_up:
        backup = book.with_suffix(f".sqlite3.bak-{dt.datetime.now():%Y%m%d-%H%M%S}")
        conn.execute("VACUUM INTO ?", (str(backup),))
        print(f"book copied to {backup.name}")

    # The app writes this table too; a book it has not opened since may not
    # have it yet, and the script should not depend on which ran first.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS debt_entries (
               debt_id        TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
               transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
               PRIMARY KEY (debt_id, transaction_id)
           ) WITHOUT ROWID"""
    )

    rows = conn.execute(
        """SELECT t.id, t.amount, t.occurred_at, t.merchant, COALESCE(t.note, '') note,
                  t.to_account_id = ? AS outward
           FROM transactions t
           WHERE ? IN (t.account_id, t.to_account_id)
           ORDER BY t.occurred_at""",
        (account_id, account_id),
    ).fetchall()

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    # One debt per thread, not per person. A thread is a name and a reason —
    # "Sankar : Mom's Surgery" — because that is the unit that has a
    # direction: he handed the money over and was paid back. Rolling a
    # person's threads together makes a two-year tab of shared dinners look
    # like one loan, and puts the arrow on whichever side happened to move
    # more money.
    threads = collections.defaultdict(list)
    for row in rows:
        threads[(counterparty(row["merchant"], row["note"]), reason(row["note"]))].append(row)

    with conn:
        # Only the ones this script wrote: a debt of your own naming the same
        # person is none of its business.
        gone = conn.execute(
            """DELETE FROM debts
               WHERE from_split = 0 AND transaction_id IS NULL
                 AND note LIKE '% out, % back, over %'"""
        ).rowcount  # their payments and entries go with them, by cascade
        if gone:
            print(f"{gone} debt records from a previous run cleared")

        written = 0
        for (who, why), items in sorted(threads.items()):
            out = [r for r in items if r["outward"]]
            back = [r for r in items if not r["outward"]]
            gave, got = sum(r["amount"] for r in out), sum(r["amount"] for r in back)
            # Whoever moved first lent it. Everything the other way is
            # repayment against that — which is the only reading under which
            # money you borrowed and paid back in full is not a debt somebody
            # forgave you.
            lent = bool(items[0]["outward"])
            principal = gave if lent else got
            payments = back if lent else out
            if principal <= 0:
                continue
            paid = sum(r["amount"] for r in payments)
            forgiven = max(principal - paid, 0)
            over = max(paid - principal, 0)
            story = (
                f"{gave / 100:,.0f} out, {got / 100:,.0f} back, over "
                f"{items[0]['occurred_at'][:10]} to {items[-1]['occurred_at'][:10]}."
            )
            if forgiven > 0:
                story += f" {forgiven / 100:,.0f} forgiven."
            if over > 0:
                story += f" {over / 100:,.0f} more than was owed."
            if why:
                story += f" {why}"
            debt_id = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO debts (id, direction, counterparty, principal, opened_on,
                                      due_on, note, settled_at, created_at, transaction_id,
                                      from_split)
                   VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0)""",
                (
                    debt_id,
                    "lent" if lent else "borrowed",
                    who,
                    principal,
                    items[0]["occurred_at"][:10],
                    story[:400],
                    now,
                    now,
                ),
            )
            # Which postings this debt is made of, said outright: the whole
            # run of hand-offs, both directions, so its page never has to
            # guess by the name on them.
            for item in items:
                conn.execute(
                    "INSERT OR IGNORE INTO debt_entries (debt_id, transaction_id) VALUES (?, ?)",
                    (debt_id, item["id"]),
                )
            for payment in payments:
                conn.execute(
                    """INSERT INTO debt_payments (id, debt_id, amount, occurred_at, note,
                                                  transaction_id, created_at)
                       VALUES (?, ?, ?, ?, NULL, ?, ?)""",
                    (
                        str(uuid.uuid4()),
                        debt_id,
                        payment["amount"],
                        payment["occurred_at"][:10],
                        payment["id"],
                        now,
                    ),
                )
            written += 1

    print(f"{written} debt records written from {len(rows)} transfers — principal,"
          " repayments and whatever was forgiven, every one settled")
    return 0


def main(book: Path) -> int:
    conn = sqlite3.connect(book)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    held = conn.execute("SELECT id FROM accounts WHERE name = ?", (HOLDING,)).fetchone()
    if held:
        print(f"“{HOLDING}” is already there — leaving the ledger alone and"
              " writing the debts again from it.")
        return rebuild_debts(conn, held["id"], book)

    rows = conn.execute(
        """SELECT t.id, t.kind, t.amount, t.account_id, t.occurred_at, t.merchant,
                  COALESCE(t.note, '') note, a.name AS account
           FROM transactions t
           JOIN categories c ON c.id = t.category_id
           JOIN accounts a ON a.id = t.account_id
           WHERE c.name IN (?, ?)
           ORDER BY t.occurred_at""",
        CATEGORIES,
    ).fetchall()

    moving, staying = [], []
    for row in rows:
        (staying if is_not_a_handoff(row["merchant"], row["note"]) else moving).append(row)

    out = sum(r["amount"] for r in moving if r["kind"] == "expense")
    back = sum(r["amount"] for r in moving if r["kind"] == "income")
    print(f"{len(rows)} rows in the lending categories")
    print(f"  {len(moving)} hand-offs  ·  out {out/100:,.0f}  back {back/100:,.0f}"
          f"  ·  net {(out - back)/100:,.0f}")
    print(f"  {len(staying)} left alone (interest, merchant credit)")

    # `VACUUM INTO` rather than a file copy: the app keeps the book in WAL
    # mode, so the file on its own is missing whatever is still in the log.
    backup = book.with_suffix(f".sqlite3.bak-{dt.datetime.now():%Y%m%d-%H%M%S}")
    conn.execute("VACUUM INTO ?", (str(backup),))
    print(f"\nbook copied to {backup.name}")

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    account_id = str(uuid.uuid4())
    with conn:
        # The account money out with people passes through. It opens owing
        # exactly what is never coming back, so it settles at nothing: that
        # is what forgiving it means.
        conn.execute(
            """INSERT INTO accounts (id, name, kind, institution, opening_balance, color,
                                     icon, archived, sort_order, created_at, credit_limit)
               VALUES (?, ?, 'cash', NULL, ?, '#676B89', 'arrow-left-right', 1,
                       (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts), ?, 0)""",
            (account_id, HOLDING, -(out - back), now),
        )

        for row in moving:
            if row["kind"] == "expense":
                conn.execute(
                    """UPDATE transactions
                       SET kind = 'transfer', category_id = NULL, to_account_id = ?
                       WHERE id = ?""",
                    (account_id, row["id"]),
                )
            else:
                conn.execute(
                    """UPDATE transactions
                       SET kind = 'transfer', category_id = NULL,
                           account_id = ?, to_account_id = ?
                       WHERE id = ?""",
                    (account_id, row["account_id"], row["id"]),
                )

    print()
    rebuild_debts(conn, account_id, book, backed_up=True)

    left = conn.execute(
        """SELECT c.name, COUNT(*) FROM transactions t JOIN categories c ON c.id = t.category_id
           WHERE c.name IN (?, ?) GROUP BY c.name""",
        CATEGORIES,
    ).fetchall()
    print("still filed under the lending categories: "
          + (", ".join(f"{n} × {c}" for c, n in left) or "nothing"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else BOOK))
