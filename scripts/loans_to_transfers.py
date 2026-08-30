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


def main(book: Path) -> int:
    conn = sqlite3.connect(book)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    if conn.execute("SELECT 1 FROM accounts WHERE name = ?", (HOLDING,)).fetchone():
        print(f"“{HOLDING}” already exists — this has been run. Nothing to do.")
        return 1

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

        # One record per person, for what is actually left between you: the
        # movements are on the ledger as transfers now, so what a debt has to
        # say is who ended up out of pocket and by how much. Everyone who
        # squared up gets none — there is nothing left to say about them.
        people = collections.defaultdict(list)
        for row in moving:
            people[counterparty(row["merchant"], row["note"])].append(row)

        written = 0
        for who, items in sorted(people.items()):
            items.sort(key=lambda r: r["occurred_at"])
            net = sum(
                r["amount"] if r["kind"] == "expense" else -r["amount"] for r in items
            )
            if net == 0:
                continue
            reasons = set()
            for item in items:
                note = item["note"].strip()
                hit = OUT.match(note) or IN.match(note)
                if hit and hit.group(2):
                    reasons.add(hit.group(2).strip())
            gave = sum(r["amount"] for r in items if r["kind"] == "expense")
            back = sum(r["amount"] for r in items if r["kind"] == "income")
            story = (
                f"{gave / 100:,.0f} out, {back / 100:,.0f} back, over "
                f"{items[0]['occurred_at'][:10]} to {items[-1]['occurred_at'][:10]}. "
                "Forgiven."
            )
            if reasons:
                story += " " + ", ".join(sorted(reasons))
            conn.execute(
                """INSERT INTO debts (id, direction, counterparty, principal, opened_on,
                                      due_on, note, settled_at, created_at, transaction_id,
                                      from_split)
                   VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0)""",
                (
                    str(uuid.uuid4()),
                    "lent" if net > 0 else "borrowed",
                    who,
                    abs(net),
                    items[0]["occurred_at"][:10],
                    story[:400],
                    now,
                    now,
                ),
            )
            written += 1
        print(f"\n{written} debt records written — the people who did not square up,"
              f" every one settled")

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
