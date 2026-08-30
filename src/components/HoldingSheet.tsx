import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { DateField, dateFieldLabel } from './DateField';
import { TransactionPicker } from './TransactionPicker';
import {
  Button, Field, Segmented, Select, Sheet, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  amountChars, evaluateAmount, money, paiseToRupeeString, quantity, rupeesToPaise,
  settleAmount, toLocalInput,
} from '../lib/format';
import type { InvestmentLot, Transaction } from '../lib/types';
import { isDeposit } from '../lib/types';
import type { Holding, HoldingKind, LotKind, Scheme } from '../lib/types';

const KINDS: SegmentOption<HoldingKind>[] = [
  { value: 'gold', label: 'Gold', icon: 'coins', accent: 'var(--amber)' },
  { value: 'fund', label: 'Mutual fund', icon: 'trending-up', accent: 'var(--violet)' },
];

/** Which kind of deposit, once the sheet is already on deposits. */
const DEPOSIT_KINDS: SegmentOption<HoldingKind>[] = [
  { value: 'fd', label: 'Fixed', icon: 'landmark', accent: 'var(--blue)' },
  { value: 'rd', label: 'Recurring', icon: 'repeat', accent: 'var(--blue)' },
];

const PURITIES: SegmentOption<string>[] = [
  { value: '10000', label: '24K' },
  { value: '9160', label: '22K' },
  { value: '7500', label: '18K' },
];

/** Where the money for a lot comes from, as far as the ledger is concerned. */
type Source = 'post' | 'link' | 'none';

const SOURCES: SegmentOption<Source>[] = [
  { value: 'post', label: 'New transfer', icon: 'arrow-left-right' },
  { value: 'link', label: 'Existing record', icon: 'search' },
  { value: 'none', label: 'Not recorded', icon: 'circle-dashed' },
];

const LOT_KINDS: SegmentOption<LotKind>[] = [
  { value: 'buy', label: 'Bought', icon: 'arrow-down-left', accent: 'var(--green)' },
  { value: 'sell', label: 'Sold', icon: 'arrow-up-right', accent: 'var(--amber)' },
];

/** Grams and units are typed as decimals — or as sums, the same as money —
 *  but stored scaled by 10^4. */
function toScaled(input: string) {
  const value = evaluateAmount(input);
  if (value === null || value < 0) return 0;
  return Math.round(value * 10_000);
}

function fromScaled(e4: number) {
  if (!e4) return '';
  return String(e4 / 10_000);
}



export function HoldingSheet({
  open, onClose, editing, seedKind,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Holding | null;
  seedKind?: HoldingKind;
}) {
  const { accounts, saveHolding, deleteHolding } = useStore();

  const [kind, setKind] = useState<HoldingKind>('fund');
  const [name, setName] = useState('');
  const [purity, setPurity] = useState('9160');
  const [grams, setGrams] = useState('');
  const [acquiredOn, setAcquiredOn] = useState('');
  // A deposit's terms: what it pays, and the two days that bound it.
  const [rate, setRate] = useState('');
  const [openedOn, setOpenedOn] = useState('');
  const [maturesOn, setMaturesOn] = useState('');
  const [schemeCode, setSchemeCode] = useState<string | null>(null);
  const [isin, setIsin] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
      setPurity(String(editing.purityE4 ?? 10_000));
      setGrams(editing.kind === 'gold' ? fromScaled(editing.unitsE4) : '');
      setAcquiredOn(editing.acquiredOn ?? '');
      setRate(editing.rateE4 ? String(editing.rateE4 / 10_000) : '');
      setOpenedOn(editing.openedOn ?? '');
      setMaturesOn(editing.maturesOn ?? '');
      setSchemeCode(editing.schemeCode);
      setIsin(editing.isin);
      setAccountId(editing.accountId);
      setNote(editing.note ?? '');
      setClosed(editing.closed);
    } else {
      setKind(seedKind ?? 'fund');
      setName('');
      setPurity('9160');
      setGrams('');
      setAcquiredOn('');
      setRate('');
      setOpenedOn('');
      setMaturesOn('');
      setSchemeCode(null);
      setIsin(null);
      setAccountId(null);
      setNote('');
      setClosed(false);
    }
    setError(null);
    setConfirming(false);
  }, [open, editing, seedKind]);

  // Only investment accounts can back a holding: a purchase posts a transfer
  // into one, and its balance then stands for what the units cost.
  const investmentAccounts = useMemo<SelectOption[]>(
    () =>
      accounts
        .filter((a) => a.kind === 'investment' && !a.archived)
        .map((a) => ({
          value: a.id,
          label: a.name,
          hint: a.institution ?? undefined,
          color: a.color,
        })),
    [accounts],
  );

  const gramsE4 = toScaled(grams);

  const submit = async () => {
    if (!name.trim()) return setError('Give the holding a name.');
    if (kind === 'fund' && !schemeCode) {
      return setError('Search for the fund so its NAV can be fetched.');
    }
    if (kind === 'gold' && gramsE4 <= 0) return setError('How many grams?');
    const deposit = isDeposit(kind);
    if (deposit && openedOn && maturesOn && maturesOn < openedOn) {
      return setError("A deposit can't mature before it was opened.");
    }
    try {
      await saveHolding({
        id: editing?.id ?? null,
        kind,
        name: name.trim(),
        accountId: kind === 'fund' || deposit ? accountId : null,
        schemeCode: kind === 'fund' ? schemeCode : null,
        isin: kind === 'fund' ? isin : null,
        purityE4: kind === 'gold' ? Number(purity) : null,
        gramsE4: kind === 'gold' ? gramsE4 : null,
        acquiredOn: kind === 'gold' && acquiredOn ? acquiredOn : null,
        rateE4: deposit ? Math.round((evaluateAmount(rate) ?? 0) * 10_000) : null,
        openedOn: deposit && openedOn ? openedOn : null,
        maturesOn: deposit && maturesOn ? maturesOn : null,
        note: note.trim() || null,
        closed,
      });
      onClose();
    } catch {
      // The store has already said what went wrong.
    }
  };

  const accent = isDeposit(kind)
    ? 'var(--blue)'
    : kind === 'gold'
      ? 'var(--amber)'
      : 'var(--violet)';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit holding' : 'New holding'}
      subtitle={
        kind === 'fd'
          ? 'One sum, left to earn until it matures'
          : kind === 'rd'
            ? 'Paid in by instalments, each earning from the day it goes in'
            : kind === 'gold'
              ? 'Physical gold — weigh it and Midas prices it'
              : 'A mutual fund, tracked by its units'
      }
      width={520}
      footer={
        <>
          {editing ? (
            <Button
              tone="danger"
              icon="trash-2"
              onClick={async () => {
                if (!confirming) return setConfirming(true);
                await deleteHolding(editing.id);
                onClose();
              }}
            >
              {confirming
                ? editing.kind === 'gold'
                  ? 'Delete this holding?'
                  : 'Delete with its entries?'
                : 'Delete'}
            </Button>
          ) : (
            <span />
          )}
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>
              {editing ? 'Save changes' : 'Add holding'}
            </Button>
          </div>
        </>
      }
    >
      <div
        className="account-form"
        style={{ ['--accent' as any]: accent }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <Segmented
          options={isDeposit(kind) ? DEPOSIT_KINDS : KINDS}
          value={kind}
          onChange={setKind}
          name="holding-kind"
          size="lg"
        />

        {isDeposit(kind) ? (
          <>
            <Field label="What it is" error={error}>
              <TextInput
                value={name}
                placeholder={kind === 'fd' ? 'HDFC 1-year FD' : 'SBI recurring deposit'}
                onChange={(e) => { setName(e.target.value); setError(null); }}
              />
            </Field>
            <Field label="Interest rate" hint="what the bank quotes, a year">
              <div className="rupee-input is-suffix">
                <TextInput
                  inputMode="decimal"
                  value={rate}
                  placeholder="7.25"
                  onChange={(e) => { setRate(amountChars(e.target.value)); setError(null); }}
                  onBlur={() => setRate(settleAmount(rate))}
                />
                <span>% a year</span>
              </div>
            </Field>
            <div className="tx-meta">
              <Field label="Opened">
                <DateField
                  value={openedOn}
                  onChange={setOpenedOn}
                  placeholder="The day it started"
                  allowClear
                />
              </Field>
              <Field label="Matures" hint="optional">
                <DateField
                  value={maturesOn}
                  onChange={setMaturesOn}
                  placeholder="When it comes back"
                  allowClear
                />
              </Field>
            </div>
            <p className="field-note">
              {kind === 'fd'
                ? 'Record the deposit itself as an entry below once it is saved — link the transfer your bank already shows, or post a new one.'
                : 'Each instalment is an entry of its own, so a month you missed is simply a month with no entry.'}
              {' '}Interest compounds quarterly, the way Indian deposits do, and stops at maturity.
            </p>
          </>
        ) : kind === 'fund' ? (
          <SchemePicker
            code={schemeCode}
            name={name}
            error={error}
            onPick={(scheme) => {
              setSchemeCode(scheme?.schemeCode ?? null);
              setIsin(null);
              if (scheme) setName(scheme.schemeName);
              setError(null);
            }}
          />
        ) : (
          <>
            <Field label="What it is" error={error}>
              <TextInput
                value={name}
                placeholder="Coins & chain"
                onChange={(e) => { setName(e.target.value); setError(null); }}
              />
            </Field>
            <Field label="Weight" hint="what it comes to on the scale">
              <div className="rupee-input is-suffix">
                <TextInput
                  inputMode="decimal"
                  value={grams}
                  placeholder="0"
                  onChange={(e) => {
                    setGrams(amountChars(e.target.value));
                    setError(null);
                  }}
                  onBlur={() => setGrams(settleAmount(grams))}
                />
                <span>g</span>
              </div>
            </Field>
            <div className="stack-field">
              <span className="field-label">
                Purity
                <span className="field-hint">what the gram price is scaled by</span>
              </span>
              <Segmented
                options={PURITIES}
                value={purity}
                onChange={setPurity}
                name="holding-purity"
              />
            </div>
            <Field
              label="Acquired"
              hint="optional — the value chart counts it from this day on"
            >
              <DateField
                value={acquiredOn}
                onChange={setAcquiredOn}
                placeholder="As long as you can remember"
                max={toLocalInput().slice(0, 10)}
                allowClear
              />
            </Field>
          </>
        )}

        {(kind === 'fund' || isDeposit(kind)) && (
          <Field
            label="Posts into"
            hint={
              investmentAccounts.length
                ? isDeposit(kind)
                  ? 'optional — an investment account for the money to sit in'
                  : 'optional — an investment account for purchases to move through'
                : 'add an investment account first to post purchases'
            }
          >
            <Select
              options={investmentAccounts}
              value={accountId}
              onChange={setAccountId}
              placeholder="Not posted to an account"
              allowClear
              disabled={!investmentAccounts.length}
            />
          </Field>
        )}

        <Field label="Note" hint="optional">
          <TextInput
            value={note}
            placeholder="Where it is kept, or why you hold it"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {editing && (
          <button
            type="button"
            className={`settle-toggle ${closed ? 'is-on' : ''}`}
            onClick={() => setClosed((v) => !v)}
          >
            <span className="settle-box">{closed && <Icon name="check" size={12} />}</span>
            Mark this holding closed
            <small>
              {editing.unitsE4 > 0
                ? `${quantity(editing.unitsE4, editing.kind === 'gold' ? 'g' : 'units')} still held — it stays in your net worth either way`
                : 'nothing left in it'}
            </small>
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Type a few words, pick the scheme; the AMFI code behind it is what sticks. */
function SchemePicker({
  code, name, error, onPick,
}: {
  code: string | null;
  name: string;
  error: string | null;
  onPick: (scheme: Scheme | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Scheme[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) {
      setHits([]);
      setFailed(null);
      return;
    }
    // Let typing settle before asking, so a fund name is one request not ten.
    const run = ++seq.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await api.searchSchemes(term);
        if (seq.current === run) { setHits(found); setFailed(null); }
      } catch (err) {
        // Say what actually went wrong. "Check your connection" is a guess,
        // and it is the wrong guess whenever the fault is on this side.
        const message = err instanceof Error ? err.message : String(err);
        console.error('scheme search failed', err);
        if (seq.current === run) { setHits([]); setFailed(message); }
      } finally {
        if (seq.current === run) setSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  if (code) {
    return (
      <div className="stack-field">
        <span className="field-label">
          Scheme
          <span className="field-hint">AMFI code {code}</span>
        </span>
        <div className="scheme-picked">
          <Icon name="check" size={14} />
          <span>{name}</span>
          <button type="button" onClick={() => onPick(null)}>Change</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack-field">
      <Field
        label="Scheme"
        hint={searching ? 'searching…' : 'search AMFI by fund name'}
        error={error}
      >
        <TextInput
          autoFocus
          value={query}
          placeholder="Parag Parikh Flexi Cap"
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {failed && <p className="scheme-note">{failed}</p>}
      {hits.length > 0 && (
        <ul className="scheme-hits">
          {hits.map((scheme) => (
            <li key={scheme.schemeCode}>
              <button type="button" onClick={() => onPick(scheme)}>
                <span>{scheme.schemeName}</span>
                <small>{scheme.schemeCode}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Recording a purchase or a sale against a holding, or fixing an old one. */
export function LotSheet({
  open, onClose, holding, editing,
}: {
  open: boolean;
  onClose: () => void;
  holding: Holding | null;
  editing?: InvestmentLot | null;
}) {
  const { accounts, saveLot, deleteLot } = useStore();
  // The form seeds itself from the account list, but must not re-seed every
  // time that list gets a new identity — the store hands back a fresh array
  // after any refresh, and paging the month inside the record picker triggers
  // one. Resetting mid-edit would throw away what had been typed.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const [kind, setKind] = useState<LotKind>('buy');
  const [qty, setQty] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput().slice(0, 10));
  // An SIP is debited on one date and allotted at another day's NAV, so the
  // units carry their own date. It follows the payment date until it is set
  // to something of its own.
  const [allottedAt, setAllottedAt] = useState(toLocalInput().slice(0, 10));
  const [cashAccountId, setCashAccountId] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('post');
  const [txId, setTxId] = useState<string | null>(null);
  const [txLabel, setTxLabel] = useState<string | null>(null);
  // Kept so the form can say, before saving, whether attaching this record
  // will move which account it points at.
  const [linkedTx, setLinkedTx] = useState<Transaction | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open || !holding) return;
    if (editing) {
      setKind(editing.kind);
      setQty(fromScaled(editing.quantityE4));
      setAmount(paiseToRupeeString(editing.amount));
      setOccurredAt(editing.occurredAt.slice(0, 10));
      setAllottedAt((editing.allottedAt ?? editing.occurredAt).slice(0, 10));
      setNote(editing.note ?? '');
      // Whether the lot wrote its posting or points at one of yours decides
      // which control to reopen it in.
      setSource(editing.transactionId ? (editing.ownsTransaction ? 'post' : 'link') : 'none');
      setCashAccountId(editing.ownsTransaction ? editing.cashAccountId : null);
      setTxId(editing.ownsTransaction ? null : editing.transactionId);
      setTxLabel(editing.ownsTransaction ? null : editing.transactionLabel);
      setLinkedTx(null);
    } else {
      setKind('buy');
      setQty('');
      setAmount('');
      setOccurredAt(toLocalInput().slice(0, 10));
      setAllottedAt(toLocalInput().slice(0, 10));
      setNote('');
      setTxId(null);
      setTxLabel(null);
      setLinkedTx(null);
      // Posting a fresh transfer needs somewhere for it to land; without an
      // investment account the only honest options are linking or nothing.
      setSource(holding.accountId ? 'post' : 'link');
      setCashAccountId(
        holding.accountId
          ? accountsRef.current.find(
              (a) => !a.archived && (a.kind === 'bank' || a.kind === 'cash'),
            )?.id ?? null
          : null,
      );
    }
    setError(null);
    setConfirming(false);
  }, [open, holding, editing]);

  /** Moving the payment date carries the allotment with it while the two are
   *  in step; once they differ, the units keep their own day. */
  const setPaidOn = (next: string) => {
    setAllottedAt((current) => (current === occurredAt ? next : current));
    setOccurredAt(next);
  };

  const cashAccounts = useMemo<SelectOption[]>(
    () =>
      accounts
        .filter((a) => !a.archived && a.id !== holding?.accountId)
        .map((a) => ({
          value: a.id,
          label: a.name,
          hint: a.institution ?? undefined,
          color: a.color,
          group: a.kind === 'credit' ? 'Cards' : 'Accounts',
        })),
    [accounts, holding],
  );

  if (!holding) return null;

  // Posting a transfer needs an investment account on the holding to land in.
  const sources = holding.accountId ? SOURCES : SOURCES.filter((s) => s.value !== 'post');

  // Attaching a transfer that currently points elsewhere moves it onto this
  // holding's account. That edits the ledger, so it is said out loud first.
  const repoint = (() => {
    if (linkedTx?.kind !== 'transfer' || !holding.accountId) return null;
    if (kind === 'buy') {
      return linkedTx.toAccountId === holding.accountId
        ? null
        : linkedTx.toAccountName ?? 'where it goes now';
    }
    return linkedTx.accountId === holding.accountId ? null : linkedTx.accountName;
  })();

  const unit = holding.kind === 'gold' ? 'g' : 'units';
  // A payment into a deposit rather than a purchase of units: the money is
  // the whole of the entry, and the sheet says so throughout.
  const intoDeposit = isDeposit(holding.kind);
  const scaled = toScaled(qty);
  const paise = rupeesToPaise(amount);
  // What it works out to per gram or unit, in paise — the number you would
  // check a jeweller's bill or a fund statement against.
  const rate = scaled > 0 && paise > 0 ? Math.round((paise / scaled) * 10_000) : 0;

  const submit = async () => {
    // A deposit has no units to count: what went in is the whole of it.
    if (intoDeposit && paise <= 0) return setError('How much went in?');
    if (!intoDeposit && scaled <= 0) return setError(`How many ${unit}?`);
    // Editing a sale shouldn't measure it against a total it is already part
    // of; the backend applies the same rule as the final word.
    const available =
      holding.unitsE4 + (editing?.kind === 'sell' ? editing.quantityE4 : 0);
    if (kind === 'sell' && scaled > available) {
      return setError(`You only hold ${quantity(available, unit)}.`);
    }
    if (source === 'link' && !txId) {
      return setError('Pick the record this entry describes.');
    }
    try {
      await saveLot({
        id: editing?.id ?? null,
        holdingId: holding.id,
        kind,
        // Deposits are stamped with a nominal one by the book itself.
        quantityE4: intoDeposit ? 10_000 : scaled,
        amount: paise,
        occurredAt,
        allottedAt,
        note: note.trim() || null,
        cashAccountId: source === 'post' && holding.accountId ? cashAccountId : null,
        transactionId: source === 'link' ? txId : null,
      });
      onClose();
    } catch {
      // Already surfaced as a toast by the store.
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        intoDeposit
          ? editing
            ? 'Edit payment'
            : holding.kind === 'rd'
              ? 'Record an instalment'
              : 'Record the deposit'
          : editing
            ? 'Edit entry'
            : kind === 'buy'
              ? 'Record a purchase'
              : 'Record a sale'
      }
      subtitle={
        intoDeposit
          ? `${holding.name} · ${money(holding.invested - holding.realised)} paid in`
          : `${holding.name} · ${quantity(holding.unitsE4, unit)} held`
      }
      width={520}
      footer={
        <>
          {editing ? (
            <Button
              tone="danger"
              icon="trash-2"
              onClick={async () => {
                if (!confirming) return setConfirming(true);
                await deleteLot(editing.id);
                onClose();
              }}
            >
              {confirming
                ? editing.ownsTransaction
                  ? 'Delete with its transfer?'
                  : 'Delete this entry?'
                : 'Delete'}
            </Button>
          ) : (
            <span />
          )}
          <div className="foot-actions">
            <span className="foot-hint"><kbd>⌘</kbd><kbd>↵</kbd> to save</span>
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>
              {editing
                ? 'Save changes'
                : intoDeposit
                  ? 'Record payment'
                  : kind === 'buy'
                    ? 'Record purchase'
                    : 'Record sale'}
            </Button>
          </div>
        </>
      }
    >
      <div
        className="account-form"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        {!intoDeposit && (
          <Segmented
            options={LOT_KINDS}
            value={kind}
            onChange={(next) => { setKind(next); setError(null); }}
            name="lot-kind"
            size="lg"
          />
        )}

        <div className="tx-meta">
          {/* A deposit is measured by its money — there are no units in it,
              so there is nothing to ask for here. */}
          {!intoDeposit && (
            <Field label={holding.kind === 'gold' ? 'Grams' : 'Units'} error={error}>
              <div className="rupee-input is-suffix">
                <TextInput
                  autoFocus
                  inputMode="decimal"
                  value={qty}
                  placeholder="0"
                  onChange={(e) => {
                    setQty(amountChars(e.target.value));
                    setError(null);
                  }}
                  onBlur={() => setQty(settleAmount(qty))}
                />
                <span>{unit}</span>
              </div>
            </Field>
          )}
          <Field
            label={intoDeposit ? 'Amount' : kind === 'buy' ? 'Paid' : 'Received'}
            error={intoDeposit ? error : undefined}
          >
            <div className="rupee-input">
              <span>₹</span>
              <TextInput
                inputMode="decimal"
                value={amount}
                placeholder="0"
                onChange={(e) => setAmount(amountChars(e.target.value))}
                onBlur={() => setAmount(settleAmount(amount))}
              />
            </div>
          </Field>
        </div>

        {rate > 0 && (
          <p className="lot-rate">
            That is {money(rate, { paise: true })} a {unit === 'g' ? 'gram' : 'unit'}
            {allottedAt !== occurredAt ? `, the NAV on ${dateFieldLabel(allottedAt)}` : ''}
            {holding.priceE4
              ? ` · ${money((holding.priceE4 / 10_000) * 100, { paise: true })} today`
              : ''}
          </p>
        )}

        <div className="date-pair">
          <Field
            label={kind === 'buy' ? 'Money paid' : 'Money received'}
            hint={holding.kind === 'fund' ? 'what your ledger uses' : undefined}
          >
            <DateField value={occurredAt} onChange={setPaidOn} />
          </Field>
          {holding.kind === 'fund' && (
            <Field
              label={kind === 'buy' ? 'Units allotted' : 'Units redeemed'}
              hint="the NAV date"
            >
              <DateField value={allottedAt} onChange={setAllottedAt} />
            </Field>
          )}
        </div>

        <div className="stack-field">
          <span className="field-label">
            In your ledger
            <span className="field-hint">how this shows up in your accounts</span>
          </span>
          <Segmented
            options={sources}
            value={source}
            onChange={(next) => { setSource(next); setError(null); }}
            name="lot-source"
          />
        </div>

        {source === 'post' && (
          <Field label={kind === 'buy' ? 'Paid from' : 'Received into'}>
            <Select
              options={cashAccounts}
              value={cashAccountId}
              onChange={setCashAccountId}
              placeholder="Pick an account"
            />
          </Field>
        )}

        {source === 'link' && (
          <div className="stack-field">
            <TransactionPicker
              value={txId}
              label={txLabel}
              title={kind === 'buy' ? 'Which record paid for this?' : 'Which record was this sale?'}
              subtitle={`${holding.name} · search and filter your whole ledger`}
              onChange={(id, label, tx) => {
                setTxId(id);
                setTxLabel(label);
                setLinkedTx(tx ?? null);
                setError(null);
                // Take the amount and date off the record being described, so
                // the two cannot drift apart by a typo.
                if (tx) {
                  setAmount(paiseToRupeeString(tx.amount));
                  setPaidOn(tx.occurredAt.slice(0, 10));
                }
              }}
            />
          </div>
        )}

        <p className="lot-hint">
          {source === 'post' &&
            (cashAccountId
              ? `A transfer of ${money(paise)} ${kind === 'buy' ? `into ${holding.accountName}` : `back out of ${holding.accountName}`} is added to your ledger, so your net worth counts this once.`
              : 'Pick the account the money moves through.')}
          {source === 'link' &&
            (repoint
              ? `${holding.accountName} becomes the ${kind === 'buy' ? 'destination' : 'source'} of that transfer, in place of ${repoint}. Nothing else about it changes, and the cost is counted once.`
              : `This entry describes a posting already in your book — nothing new is written, and ${holding.accountName ?? 'the holding'} keeps the cost it already carries.`)}
          {source === 'none' &&
            'Nothing is posted to your accounts — for anything bought before you started keeping the book.'}
        </p>

        <Field label="Note" hint="optional">
          <TextInput
            value={note}
            placeholder="Anything worth remembering"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}
