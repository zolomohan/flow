# Midas on iOS

A plan for putting this book on a phone. Written after reading the tree, not
after building it — the sizings are estimates and the gotchas are the ones
visible from here, not the ones a device will find.

The short version: **the Rust core is already portable.** Every dependency
cross-compiles to `aarch64-apple-ios` without a fight — `rusqlite` bundles its
own SQLite C, `reqwest` is on rustls so there is no OpenSSL to cross-build, and
`calamine`, `chrono` and `uuid` are pure Rust. All six price endpoints are
HTTPS, so App Transport Security is satisfied as it stands. `lib.rs` touches no
window, menu or tray API and already carries `#[cfg_attr(mobile,
tauri::mobile_entry_point)]`. `vite.config.ts` still has its `TAURI_DEV_HOST`
scaffold.

So this is not a port. It is three pieces of work: a **shell** that fits a
phone, a **decision about which book the phone shows**, and **Siri capture
rebuilt**, because the way it works on the Mac is impossible inside an iOS
sandbox.

---

## The fork this plan assumes

Everything below depends on one question, and it is worth answering before
Phase 2 rather than discovering the answer in Phase 5.

**Is the phone a capture-and-glance companion to the Mac's book, or a peer that
holds its own copy?**

This plan assumes **companion**, for a reason worth stating plainly: there is no
sync layer in Midas today and nothing to hang one on. One SQLite file, balances
derived in SQL rather than stored, no operation log, no row versioning, no
stable notion of "who wrote this last". Two books that both accept edits need
all of that. One book that accepts edits and one client that appends to a queue
needs none of it — and `capture.rs` has already built that queue.

The four ways it could go, worst-first:

| | What it is | Cost |
|---|---|---|
| SQLite in an iCloud container | Both devices open the same file over iCloud Drive | Cheap and **wrong** — whole-file sync with no coordination between two open connections corrupts the book. Only safe under a strict one-device-at-a-time lock, which is not a design, it is a promise you will break |
| Sneakernet | `export_book` / `import_book` over Files and AirDrop | Free, already works. Fine occasionally, useless daily |
| **Companion** | Mac is the book of record; the phone appends entries and reads a snapshot | Weeks. Reuses the capture queue wholesale |
| Peer | CloudKit record-per-row, or a small server, with a change log | Months, and a schema change. A project of its own |

If the answer turns out to be *peer*, Phases 0, 1, 3 and 4 below are unchanged
and still the right first moves — only Phase 2 and the screen list in Phase 5
grow.

---

## Ground rules

**The Mac must not regress.** Every change here is additive or behind `cfg`.
`yarn tauri build` for macOS keeps passing at the end of every phase, and the
Rust test suite (128 tests across `db`, `capture`, `plans`, `cards`, `import`)
keeps passing on the host. Nothing in this plan needs a test deleted.

**Prove the cross-compile before touching a stylesheet.** A day of CSS is
wasted if `rusqlite` will not build for the simulator. Phase 0 exists to find
that out on day one, and it is ugly on purpose.

**One book of record.** Under the companion model the phone never writes to the
ledger. It appends to the queue and reads a snapshot. The moment it writes
directly, this becomes the peer plan, and it should be chosen deliberately
rather than arrived at.

**Nothing is inferred from a sentence that the book can answer.** The existing
capture resolver already refuses to post with anything unresolved. Whatever
replaces the file drop keeps that rule — a half-filed posting is one nobody
comes back to.

---

## Phase 0 — running and ugly (≈1 day)

The goal is a simulator showing the desktop layout squeezed onto a phone,
unusable and correct. It proves the toolchain and the Rust build; it proves
nothing else, and that is the point.

- Xcode and its command line tools, CocoaPods, then
  `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`.
- `yarn tauri ios init` — generates `src-tauri/gen/apple/`, an Xcode project
  that wants committing. `.gitignore` has no entry for it yet; the scaffold
  usually writes its own, so check what it left before the first commit.
- `yarn tauri ios dev` against a simulator. No Apple account needed for this.
- `yarn tauri icon` for the iOS icon set. The identifier `com.mohanraj.midas`
  is already valid and does not change.

Expect to spend the day on signing and Pods rather than on Rust. If SQLite
fails to build, it will be a deployment-target mismatch (`IPHONEOS_DEPLOYMENT_TARGET`),
not a real portability problem.

**Done when** the app launches in the simulator, seeds its demo book and draws
the Overview screen, however badly.

---

## Phase 1 — the core, made correct on iOS (≈1–2 days)

Small, localised, mostly one-line changes. All of them are bugs that are silent
rather than loud, which is why they are listed before any UI work.

- **`src-tauri/capabilities/default.json` is desktop-shaped.** It points at
  `desktop-schema.json` and scopes to `windows: ["main"]`. On iOS it needs
  `"platforms": ["iOS"]` and webview scoping — without it the `dialog` calls in
  `Settings.tsx` and `ImportSheet.tsx` fail at the permission layer, and they
  fail quietly.
- **`capture.rs:63` reads `$HOME/Library/Mobile Documents/…`.** On iOS `$HOME`
  is the app's own sandbox container, so `default_inbox()` resolves to a path
  that cannot exist and the inbox is permanently, silently empty. Needs a
  per-platform default. Phase 2 decides what the iOS one is.
- **Decide where the book lives.** `app_data_dir()` in `lib.rs:614` works, but
  on iOS it is invisible to the user and to Finder backup. Application Support
  (hidden, backed up) versus Documents (visible in Files, restorable by hand)
  is a real choice with no default worth inheriting.
- **`import_book` writes its safety backup beside the source file**
  (`lib.rs:585`). On iOS the source arrives as a security-scoped picker URL you
  generally cannot write next to. The backup belongs in app data regardless of
  platform — this is arguably a Mac bug too.
- **Gate the demo seed.** `lib.rs` seeds a sample book on any fresh install. On
  a companion phone that means being greeted by thirteen months of fiction on
  first launch, with the real book elsewhere.
- **`viewport-fit=cover`** in `index.html`, so Phase 3 has safe-area insets to
  work with.

**Done when** the simulator app reads and writes a real book, fetches prices,
and the Mac build is untouched.

---

## Phase 2 — capture, rebuilt (≈3–5 days)

An iOS app **cannot read another app's iCloud container**. The Shortcuts
container drop that `capture.rs` reads on the Mac is not a permission away from
working on the phone; it is structurally impossible. This phase replaces it.

Three routes, and they stack rather than compete:

1. **URL scheme** — `midas://capture?text=…` from the Shortcut. An afternoon.
   Worth doing first even if it is later replaced, because it makes the whole
   loop testable on a device before any Swift is written.
2. **Midas's own iCloud container** — declare one, plus `UIFileSharingEnabled`
   and `LSSupportsOpeningDocumentsInPlace`, and point the Shortcut's *Save
   File* at Midas's own folder. The queue, the resolver and the "words are
   never rewritten" contract all survive intact; only the directory changes.
   The bonus is real: the Mac can read the same container, which retires the
   `iCloud~is~workflow~my~workflows` hack on both platforms and makes
   `default_inbox()` one path instead of two.
3. **A real App Intent** in Swift inside `gen/apple/`, calling the existing
   resolver through a small Tauri plugin. "Hey Siri, Midas, three hundred at
   Swiggy" with no file in the middle. This is the end state and it is the only
   one that feels like an app rather than a workaround.

Do 1, then 2, then 3 when the rest is stable. Route 2 is the one that pays for
itself immediately on both platforms.

**Also in this phase:** the poll trigger at `store.tsx:374` hangs off
`window.focus`, which WKWebView fires unreliably. It wants `visibilitychange`
or a Tauri lifecycle event. The Mac keeps working either way.

---

## Phase 3 — the shell (≈1 week, plus a design decision)

`app.css` is 7,500 desktop-first lines and the shell is a hard
`grid-template-columns: var(--sidebar-w) minmax(0, 1fr)`. The narrowest
breakpoint anywhere in the file is 620px. Nothing below that has been thought
about, and a phone is 390.

- **Navigation, and the decision inside it.** Sidebar becomes a bottom tab bar,
  which holds five destinations. There are thirteen screens — Overview,
  Transactions, Accounts, Cards, Debts, Investments, Planned, Insights, Taxes,
  Templates, Labels, Siri, Settings. Four or five earn a tab and the rest live
  behind *More*. Under the companion model the answer is probably Overview,
  Transactions, a capture action, and More; under the peer model it is a
  genuine IA exercise.
- **Chrome.** `--titlebar-h` exists to clear the Mac's traffic lights; on iOS
  that same band is the status bar, which is a happy coincidence rather than a
  free pass. Safe-area insets throughout, home-indicator padding under the tab
  bar.
- **The back stack is already there.** The history work behind ⌘[ and ⌘] maps
  straight onto the edge-swipe gesture. This is the one piece of luck in the
  whole port.
- **Sheets.** Centred modals capped at `min(880px, 100vw - 48px)` become
  full-height bottom sheets with drag-to-dismiss. Keyboard avoidance is manual:
  WKWebView does not resize the viewport, so it is driven off `visualViewport`.

---

## Phase 4 — the touch pass (≈1 week)

Mechanical but broad, and it cannot be skipped or the app feels like a website.

- **115 `:hover` rules.** Every hover-revealed affordance needs a tap
  equivalent — row actions become swipe actions or a long press. A hover rule
  that reveals nothing is fine to leave; one that reveals a control is a
  feature that does not exist on a phone.
- **Inputs at ≥16px**, or iOS zooms the page on focus. `inputmode="decimal"` on
  every amount field.
- `overscroll-behavior` to kill the rubber band, tap-highlight suppression,
  selection callouts off on long press, `touch-action` where a gesture is ours.
- **`DateField` wants a touch variant.** It is a custom component, so this is
  ours to build rather than the platform's to provide.
- **Measure before optimising.** `Transactions.tsx` is not virtualised, which is
  invisible on a Mac and may not be on a phone with a multi-year book. The same
  goes for the `motion` springs and the charts that draw themselves in — the
  donut, the 12-month flow and the calendar heat-map are all sized for desktop
  widths and all animate on entry.

---

## Phase 5 — the screens

Per-screen work, ordered by what a phone is actually for. Under the companion
model the top three are most of the value and the rest can wait.

| Screen | What it needs |
|---|---|
| Capture / Siri | The reason the phone exists. Words in, resolved or waiting |
| Transactions | Dense rows re-laid for 390pt; filters into a sheet; search stays |
| Overview | Hero balance and flow survive; the donut needs a phone size |
| Accounts / Cards | Card grid to a single column; mostly reads already |
| Debts, Investments, Planned | Detail screens are close to fine; list density is not |
| Insights, Taxes | Charts are the whole screen — a real sizing pass each |
| Templates, Labels, Settings | Forms. Phase 4's input work covers most of it |
| Import | See below |

---

## Not making the trip

**Statement import.** A wide review table driven by an `.xls` file picker. The
Files picker can hand over the file, so it is possible — but the review is the
part that matters and it is miserable at 390pt. Desktop-only, deliberately, and
say so in the UI rather than letting it half-work.

**`scripts/`.** The Wallet CSV importer, the rule seeder and the logo fetcher
are Python that writes to the book directly. Mac-side by nature.

**The keyboard.** ⌘K, `N`, ⌘1–6 and ⌘↵ all vanish. The command palette survives
as a search screen, which it half is already.

---

## Gotchas worth knowing before they cost a day

- Permission failures on iOS are quiet. A capability file that does not cover
  the platform produces a dialog that never opens and no error worth reading.
- `$HOME` on iOS is a sandbox container, so any path built from it is wrong in
  a way that looks like an empty result rather than a crash. `capture.rs` is
  the known instance; it is worth grepping for others before Phase 2 ends.
- A free Apple ID signs onto your own device with 7-day provisioning, which
  expires mid-test and looks like a broken build. $99/yr removes that and is
  the only way to TestFlight.
- Simulator and device disagree about fonts, safe areas and keyboard behaviour.
  General Sans is bundled in `public/fonts` so it will not be a network
  problem, but check it on glass before believing the simulator.

---

## Order, and what it costs

| Phase | | Estimate |
|---|---|---|
| 0 | Running and ugly | 1 day |
| 1 | Core correct on iOS | 1–2 days |
| — | **Answer the companion/peer question** | — |
| 2 | Capture rebuilt | 3–5 days |
| 3 | Shell | ~1 week |
| 4 | Touch pass | ~1 week |
| 5 | Screens | Open-ended; ordered so it can stop anywhere useful |

Phases 0 and 1 are worth doing this week regardless of the fork — they are
cheap, they are additive, and they turn every question below them from a guess
into a measurement.
