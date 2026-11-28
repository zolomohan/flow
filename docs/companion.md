# flow on the iPhone: the companion

How the phone and the Mac keep one book between them. This replaces the
"companion or peer" question in `PLAN.md`. The answer is a companion, with
writes going both ways.

> **Update (Nov 2026): the book moves to the phone.** Flow is going
> phone-first. Which device holds the book is now a setting (`book_role`:
> `owner` or `companion`), not a fixed fact. Everything below still holds
> with "Mac" read as *the owner* and "phone" as *the companion*: once the
> book has moved, the phone publishes and applies, and the Mac works on a
> copy and queues its changes. See "Moving the book" at the end.

## The shape of it

```
   Mac (book of record)                  iCloud: flow's own container             iPhone
   ────────────────────                  ────────────────────────────            ──────
   midas.sqlite3  ── publish ──▶  book.sqlite3 + book.json   ── read ──▶  local copy
                  ◀── apply ───  ops/<device>.jsonl          ◀── append ─  (applied at once,
   conflicts table                                                          queued as well)
```

- **The Mac is the only book of record.** Nothing but the Mac ever writes to
  `midas.sqlite3`.
- **The Mac publishes a snapshot** of the whole book to the shared folder
  after every change (debounced): a SQLite copy made with `VACUUM INTO`,
  renamed into place so a reader never sees half a file, plus a small
  `book.json` saying when it was taken and which of each device's changes it
  already holds.
- **The phone keeps its own copy** of that snapshot and works on it as if it
  were the book: balances, the ledger and debts move the moment you save.
- **Every phone write is also queued.** The phone appends it to its own file,
  `ops/<device-id>.jsonl`. Each device only ever appends to its own file, so
  iCloud never has two writers on one file and there is never a merge to lose.
- **The Mac applies the queue** in order, through the same Rust functions its
  own screens call, then publishes a fresh snapshot.
- **The phone catches up.** When a newer snapshot arrives, the phone swaps it
  in and replays whatever it has queued that the snapshot doesn't hold yet.
  The Mac's own edits reach the phone the same way.

### What an op is

An op is a command the app already has, with the arguments it was called with:

```json
{"seq": 41, "at": "2026-11-27T09:14:03Z", "cmd": "save_transaction",
 "args": {"input": {...}},
 "ids": ["6f1c…", "a20e…"],
 "base": [{"table": "transactions", "id": "9b3e…", "hash": "c4f1a2…"}]}
```

- `cmd` and `args` are exactly what the screen sent to the command layer, so
  there is one way to change the book and the queue reuses it. A command that
  isn't on the companion's list yet is not run on the phone. The phone says
  it can't do that yet, so nothing lands in the queue that the Mac would turn
  down.
- `ids` are the ids the phone made while applying the op to its copy. When
  the Mac replays the op it hands them back out in the same order, so a
  transaction added on the phone has the same id on both sides, and a later
  edit to it from the phone finds it. `at` does the same for timestamps.
- `base` is a hash of each existing row the op changes, taken on the phone
  just before applying it. If the Mac's row no longer matches, the row
  changed on the Mac (or on another device) in the meantime. See conflicts.

### Conflicts

New records can't clash, so they always go straight in. An edit or delete
whose `base` no longer matches isn't applied. It goes into a conflict inbox on
the Mac, holding the op, the row as the phone saw it and the row as it is now.
You accept it (the op is applied over the current row) or drop it. The same
inbox takes an op the book refuses outright, such as a payment against a
deleted debt, with the reason it was refused. Either way the phone's next
snapshot shows what was decided, and its pending marker for that op clears.

### When the Mac is asleep or offline

The phone keeps working on its copy, with a line saying how old the snapshot
is ("as of 2:14 PM") and a pending marker on anything not yet applied.
Nothing waits on the Mac being awake. The ops sit in iCloud until it is.

### Pairing and security

There is no pairing step: both apps use the same Apple ID and the same iCloud
container. Data is encrypted in transit and at rest on Apple's side, and end
to end with Advanced Data Protection on. The shared folder holds a full copy
of the book, so it is exactly as private as the Apple ID.

### Claude on the phone

The `ant` sign-in can't work on iOS, because an iPhone app can't run another
program. The phone uses an API key. The Mac keeps a pasted key in the
Keychain today. Moving that item into a shared keychain access group, synced
through iCloud Keychain, means a key pasted once on the Mac is there on the
phone too. Ask on the phone reads its local copy. A change Ask proposes and
you apply becomes an op like any other.

## What Raj does (needs the paid account)

1. **Enrol** in the Apple Developer Program ($99 a year) with the Apple ID
   the Mac and iPhone are signed in to. Approval can take a day or two.
2. **Note the Team ID** (ten characters, under Membership in the developer
   account) and send it over. It goes into `tauri.conf.json` and the Xcode
   project's signing settings.
3. **Create the iCloud container** under Certificates, Identifiers &
   Profiles › Identifiers › iCloud Containers: `iCloud.com.mohanraj.midas`.
4. **Enable iCloud on the App ID** `com.mohanraj.midas` (iCloud Documents,
   with the container above ticked) and **Keychain Sharing**.
5. **Register the iPhone** as a device (Xcode does this when the phone is
   plugged in and selected as a run target).

Steps 3 to 5 can be done for you from Xcode once the account exists. They
are listed so nothing is a surprise.

## Order of work

| # | Piece | Needs the account | Estimate |
|---|---|---|---|
| 1 | Mac: publish the snapshot, apply the queue, pinned ids and times, conflict table, tests. Folder set by hand for now | No | 3–5 days |
| 2 | Mac: conflict inbox screen, sync status in Settings | No | 1–2 days |
| 3 | Signing, entitlements, iCloud container on both apps; the folder moves into it | Yes | 1 day |
| 4 | Phone: open the local copy, swap in new snapshots, replay pending | Yes | ~1 week |
| 5 | Phone: writes through the queue (add, edit, delete, debts, plans) | Yes | ~1 week |
| 6 | Claude key in iCloud Keychain; Ask on the phone | Yes | 2–3 days |

Until step 3, the Mac side can be tested end to end with any folder, and a
second copy of the Mac app pointed at the same folder can stand in for the
phone.

## Ground rules

- Off until a folder is set. With no companion folder configured, the Mac
  app behaves exactly as it does today.
- The Mac never trusts the phone's copy. It only ever reads ops and applies
  them through its own checks.
- Nothing on the Mac regresses: the existing Rust tests keep passing, and the
  new ones cover publish, apply, id pinning and conflicts.

## Moving the book

Settings › Your data › Shared book, on both devices, with the shared folder
set on each:

1. **On the device that holds the book now, Hand over.** Every queued change
   is applied, a last snapshot is published, and the device becomes a
   companion.
2. **On the other device, Take over.** The snapshot becomes its book of
   record and it applies whatever is still queued, its own included.

From then on the companion's edits to transactions, debts and plans go
through the queue; anything else it changes stays on its own copy until the
next snapshot replaces it (more of the app moves onto the queue later). Each
device keeps its own role, name and folder across snapshots. On the phone the
book lives in the App Group container (`group.com.mohanraj.midas`) once that
entitlement is signed in, so the share extension, widgets and the Log
transaction intent can open it; until then it stays in the app's data folder,
and a book there is copied across the first time the group folder appears.
