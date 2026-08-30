# Reconciling a real account against Midas

A runbook for the thing this repo keeps needing: taking a statement the bank or
card issuer exported, working out what the book is missing, and writing it in so
the balance in Midas equals the balance the institution says you have.

Written after doing it for HDFC (bank), a Swiggy HDFC card, and a mutual-fund
portfolio. The gotchas near the end cost the most time — read those first if you
are debugging rather than starting fresh.

---

## Ground rules

**Close Midas before writing.** SQLite in WAL mode tolerates a second writer, so
this is not about corruption. It is that the running app shows stale data, and if
you then edit a row from that stale view you silently overwrite what was just
written. Quit it, write, reopen.

**Back up first, every time.**

```bash
cp ~/Library/Application\ Support/com.mohanraj.midas/midas.sqlite3 \
   ~/Library/Application\ Support/com.mohanraj.midas/midas-backup-before-<thing>.sqlite3
```

**Dry-run against a copy, not the book.** Every script here should take the DB
path as an argument and only `commit()` behind an explicit `--commit` flag. Copy
the live DB, run with `--commit` against the *copy*, inspect the result, then run
against the real one. A dry run that never commits cannot be inspected — you will
query an unchanged file and draw the wrong conclusion.

**Find the residual, don't plug it.** A plug that closes a gap you have not
explained is a bug wearing a bow tie. Twice here a small unexplained remainder
turned out to be a real defect in the matching code. Chase anything above a rupee.

---

## Part 1 — Bank statement (HDFC .xls)

HDFC exports legacy BIFF `.xls`. `xlrd` reads it; `openpyxl` does not.

Transaction rows are the ones whose first cell parses as `dd/mm/yy`. Header,
address block and footer all fail that test and fall away on their own. Columns:
date, narration, ref, value date, withdrawal, deposit, **closing balance**.

**Validate the statement before trusting it.** The closing-balance column is a
running total, so consecutive rows must chain:

```
balance[n-1] + signed(row[n]) == balance[n]
```

Zero breaks across a set of statements means they are complete and gapless, and
the bank side becomes ground truth. This is worth doing first — it tells you the
statements are sound before you start blaming the book.

### The anchor

Do **not** reconstruct history by walking `opening_balance` backwards. It is not
a constant: `commit_import` mutates it (see Gotchas). The only sound comparison is
at a single point in time.

Pick an anchor date where the book was believed correct — for us, the first
imported row. Then:

```
gap_today = anchor_gap + (book movement since anchor) − (bank movement since anchor)
```

If `anchor_gap` is near zero, every rupee of the discrepancy is after the anchor
and you can itemise it. This identity needs no matching at all and is exact, so
it is the thing to establish before any fuzzy work.

### Matching rows

In order of confidence:

1. **Exact** — same amount, same direction, nearest date. Greedy over all pairs
   sorted by date distance.
2. **Fuzzy amount** — hand-entered rows get rounded to the rupee (`₹149,613.00`
   against the bank's `₹149,613.44`). Allow ±₹1 or 0.5%, within ~7 days.
3. **Splits and aggregations** — one bank line entered as several book rows, or
   several bank lines rolled into one. Subset-sum, combinations of 2–3, ±₹2.

**Subset-sum on small amounts is mostly noise.** It will always find *something*.
Below about ₹1,000 the matches are coincidence — treat them as unverified. Above
that they are usually real, and repeating patterns (rent split into a transfer
plus an expense, three months running) are the strongest signal there is.

### Categories of finding

- **Missing** — on the statement, not in the book. Import them.
- **Extra** — in the book, no bank line. Usually a duplicate: you logged it by
  hand, then the importer brought in the bank's version. The rounded amount is
  the tell.
- **Date-shifted** — matched but days apart. Not an error; the bank posts when it
  settles.
- **Amount mismatch** — matched, different figure. Fix to the bank's number.

Tag findings with a label so they can be filtered in the app, and **tag both
sides of a duplicate pair** so they can be compared before deleting one:

```sql
INSERT INTO labels (id,name,color,created_at) VALUES (?,?,?,?);
INSERT OR IGNORE INTO transaction_labels (transaction_id,label_id) VALUES (?,?);
```

Deleting a label only removes the label and its join rows. `transactions` has no
FK to `labels`, so records are never at risk.

---

## Part 2 — Mutual funds (CAMS/KFintech .xlsx)

Read with `openpyxl`. Rows are `Scheme Name | Transaction Type | Units | NAV |
Amount | Date`, dates as `08 Apr 2024`.

**Funding matches on round numbers.** The bank debit is round and the purchase
lands ₹1–8 under it — the difference is broker and stamp charges. `₹100,000 →
₹99,995`, `₹50,000 → ₹49,997`, `₹10,000 → ₹9,999`. Allotment is 0–5 days after
the debit, and several schemes bought on one day usually share a single debit, so
match a *day's* purchases against a combination of debits.

### Scheme codes

Prices only refresh for holdings with a non-empty `scheme_code`
(`db.rs`, `refresh` query). Get codes from AMFI:

```bash
curl -s https://portal.amfiindia.com/spages/NAVAll.txt -o navall.txt
```

Format is `code;isin;isin2;name;plan;option;nav;date` — the name spans fields
4–6. Match on name, then **verify** by pulling the history and checking a NAV you
already know from the statement:

```
https://api.mfapi.in/mf/<scheme_code>
```

Every purchase NAV should match to the paisa. Redemption NAVs can differ slightly
(exit pricing) — that is not a wrong scheme. The API 502s intermittently; retry
with backoff.

Backfill `price_cache` (key `mf:<code>`, `price_e4` = NAV × 10000) and
`price_history` so charts have real history rather than a single point.

---

## Part 3 — Credit card + Swiggy orders

CRED exports `~|~`-delimited CSV. Transaction rows start `Domestic` or
`International`; the `Cr` flag in field 6 marks a credit.

The card descriptor is useless for telling *what* you bought — there are a dozen
Swiggy variants (`RAZ*Swiggy`, `PYU*Swiggy Food`, `RSP*INSTAMART`,
`BUNDL TECHNOLOGIES`, `SWIGGY E COM`…) and `BUNDL TECHNOLOGIES` is just the legal
entity, so it could be food or grocery. **Amount plus timestamp is the only
reliable join to an order.**

### Getting the orders

No tooling here can reach an authenticated session — `WebFetch` refuses private
URLs and `curl` has no cookies. The orders have to come from the browser. Paste
these into the console on the relevant site.

**Food** — on `swiggy.com/my-account/orders`. Items carry `final_price`, so food
never needs a separate detail call.

```js
(async () => {
  const CUTOFF = new Date('2026-06-20');
  const seen = new Map();
  let cursor = '', page = 0, stop = false;
  while (!stop && page < 80) {
    const r = await fetch(`https://www.swiggy.com/dapi/order/all?order_id=${cursor}`,
                          { credentials: 'include' });
    if (!r.ok) { console.error('HTTP', r.status); break; }
    const orders = (await r.json())?.data?.orders ?? [];
    if (!orders.length) break;
    for (const o of orders) {
      seen.set(o.order_id, o);
      if (new Date(o.order_time) < CUTOFF) stop = true;
    }
    cursor = orders.at(-1).order_id; page++;
    console.log(`page ${page}: ${seen.size} total, oldest ${orders.at(-1).order_time}`);
    await new Promise(s => setTimeout(s, 400));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify([...seen.values()], null, 2)],
                               { type: 'application/json' }));
  a.download = 'swiggy-orders.json'; a.click();
})();
```

**Instamart** — different origin (`instamart.in`) and a two-step API. The list
endpoint gives names and quantities but **no prices**; prices need the detail
call. This one snippet does both, and by driving the API directly it cannot miss
the first page the way a network-interception hook does.

```js
(async () => {
  const STOP = new Date('2026-07-01').getTime();
  const seen = new Map();
  let cursor = Date.now();
  for (let page = 0; page < 12; page++) {
    const r = await fetch(`/api/instamart/orders?order_type=DASH&count=10&from_time=${cursor}`,
                          { credentials: 'include' });
    const os = (await r.json())?.data?.orders ?? [];
    if (!os.length) break;
    os.forEach(o => seen.set(o.order_id, o));
    const oldest = Math.min(...os.map(o => o.created_at));
    if (oldest < STOP) break;
    cursor = oldest;
  }
  const out = [];
  for (const id of seen.keys()) {
    const r = await fetch(`/api/order/v3/getOrderDetails/${id}`, { credentials: 'include' });
    out.push({ order_id: id, list: seen.get(id), detail: await r.json() });
    await new Promise(s => setTimeout(s, 300));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'instamart-orders.json'; a.click();
})();
```

If an endpoint has moved, hook `fetch` and `XMLHttpRequest.prototype.open`, log
every `/api/` or `/dapi/` URL with a flag for whether the body contains
`"price"`, then click through the UI and read off the green ones.

Useful paths in the payloads:

| What | Where |
|---|---|
| Food order total | `order_total` |
| Food line items | `order_items[]` → `name`, `quantity`, `final_price` |
| Food payment method | `payment_method_involved` — **check this** |
| Instamart total | `detail.data.totalBill` |
| Instamart line items | `detail.data.shipmentDetails[].items[]` → `description`, `quantity`, `finalPrice` |
| Instamart fees | `detail.data.billDetail.billLineItems[]` |

**Reconcile each order before splitting it**: card charge == `totalBill` ==
sum(items) + fees. If all of them tie, the split arithmetic is safe.

### Splitting

Use `transaction_splits`, not several transactions — one card charge keeps one
row. `replace_splits` enforces: at least two parts, every part > 0, no group
(parent) categories, and **parts must sum exactly to the transaction amount**.
Spread delivery and handling fees pro-rata across the items so the total holds,
and give the last line the remainder rather than rounding it.

An order whose items all fall in one category needs **no** split — just file it.

### Cashback

On this card: **10% of a day's eligible orders, posted 2 days later, capped at
₹1,500 per statement cycle.** Not every order earns it. When the cycle cap is
reached the final credit is truncated so the cycle lands on exactly ₹1,500.

That makes per-order attribution imperfect. Whatever you do, **preserve the
total** — net it off the order where the pairing is clear, otherwise write an
income row under Refunds & Rewards. The balance only depends on the sum.

### Orders with no card charge

Check `payment_method_involved` before assuming a missing charge is an error. A
Cash order genuinely never touched the card; putting it there breaks the
reconciliation. File it against the account that actually paid.

---

## Gotchas

**`opening_balance` is not a historical constant.** `commit_import` mutates it:
a row imported as already-counted moves the opening the other way so no balance
shifts (`db.rs`, `commit_import`). Any reconstruction that walks it backwards
through time is meaningless. Compare at one point only.

**An investment account's ledger must equal the *linked* cost, not the total
cost.** `holding_marks` computes `posted` with an **inner join** on
`investment_lots.transaction_id`, so lots with no funding transaction contribute
nothing. `apply_marks` then sets `revaluation = market − posted`. An unlinked lot
already reaches net worth in full through revaluation — putting its cost into the
opening balance as well double-counts it. This inflated an account by ₹17.7 lakh
until it was caught.

**Editing a transfer changes two accounts.** Correcting a transfer's amount on
the account you are reconciling silently moves the counterparty too. After any
write, print *every* account balance, not just the one you meant to touch.

**Splitting one bank line into two book rows breaks naive duplicate detection.**
A ₹7,794 utility bill logged by hand as ₹5,794 + ₹2,000 will not match the single
imported ₹7,794 row, so a same-amount duplicate finder misses it entirely. Check
sums of same-day rows too.

**Never derive "which credit was consumed" by subtracting totals.** Track it at
the point of matching. Doing it afterwards by greedily draining buckets produced
a ₹43.30 error here — two cashbacks netted off orders *and* written as income,
three others dropped.

**Only one lot per transaction.** `idx_lot_tx` is a unique index on
`investment_lots(transaction_id)`. A day whose single debit funded several
schemes can link only one lot; the rest stay unlinked, which is fine.

**Window boundaries create phantom findings.** Cutting at 1 July put a rent
payment the bank posted on 30 June outside the window while the book row dated
1 July sat inside — which looked like ₹48,147 of phantom spending and was purely
an artefact. Widen the candidate pool beyond the reporting window.

---

## Verifying

Compute the balance with the app's own expression rather than your own, so you
are checking the same thing the UI shows:

```sql
a.opening_balance
+ COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND kind='income'),0)
- COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND kind='expense'),0)
- COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND kind='transfer'),0)
+ COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND kind='transfer'),0)
```

For an investment account the displayed figure is this **plus**
`revaluation = market − posted`.

Then check the movement inside the window separately:

```
book movement over window  ==  statement movement over window
```

If that is exactly zero the transactions are right, and any remaining difference
is inherited from before the window — which is honest to carry as an opening
balance, and worth saying out loud rather than burying.
