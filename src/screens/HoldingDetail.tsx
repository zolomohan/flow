import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { PriceHistory } from '../components/PriceHistory';
import { Button, Card, CardHead, Empty } from '../components/ui';
import { api } from '../lib/api';
import {
  dayLabel, money, percent, perUnit, quantity, shortDayLabel, unitPrice,
} from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { isDeposit } from '../lib/types';
import type { Holding, InvestmentLot, ValuePoint } from '../lib/types';

/** 22K reads better than 9160 everywhere it is shown. */
export function carats(purityE4: number | null) {
  if (!purityE4) return '24K';
  return `${Math.round((purityE4 / 10_000) * 24)}K`;
}

export function unitOf(holding: Holding) {
  return holding.kind === 'gold' ? 'g' : 'units';
}

/**
 * AMFI names read `Fund name - Plan - Option`, which is three facts crammed
 * into one line and mostly repeated across every fund you own. The plan and
 * option are qualifiers rather than identity, so they drop to a second line
 * and the fund's actual name gets to be the thing you read.
 */
export function splitName(holding: Holding) {
  if (holding.kind === 'gold') {
    return { title: holding.name, detail: carats(holding.purityE4) };
  }
  const parts = holding.name.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { title: holding.name, detail: null };
  return { title: parts[0], detail: parts.slice(1).join(' · ') };
}

/** Days between two ISO dates, as a readable span. */
/** How long something was held. `until` for a holding that has ended; today
 *  for one that has not. */
function heldFor(since: string, until?: string) {
  const end = until ? new Date(until).getTime() : Date.now();
  const days = Math.floor((end - new Date(since).getTime()) / 86_400_000);
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} ${months === 1 ? 'month' : 'months'}`;
  return `${(days / 365.25).toFixed(1)} years`;
}

export function HoldingDetail({
  holding, share, onBack, onEdit, onAddLot, onEditLot,
}: {
  holding: Holding;
  /** Its slice of the portfolio, 0–1. */
  share: number;
  onBack: () => void;
  onEdit: () => void;
  onAddLot: () => void;
  onEditLot: (lot: InvestmentLot) => void;
}) {
  const unit = unitOf(holding);
  const { title, detail } = splitName(holding);
  const priced = holding.priceE4 !== null;
  // Gold is weight and a rate. There is no purchase history behind it and no
  // cost to measure a return against, so both are left off — what it can show
  // is where the rate itself has been.
  const isGold = holding.kind === 'gold';
  // A deposit earns rather than being priced, so it has no NAV line, no
  // units, and its own words for what the entries against it are.
  const deposit = isDeposit(holding.kind);

  // A position sold out of. Its market value is nothing and its NAV is
  // somebody else's business now: what is left to say is what went in, what
  // came back, and over how long.
  const soldOut = holding.closed && !isGold && !deposit;
  const realisedGain = holding.realised - holding.invested;

  const gain = soldOut ? realisedGain : holding.totalReturn;
  const cost = holding.invested - holding.realised;
  // Against the money put in, for a holding that has given all of it back —
  // net cost is nothing once you have sold out, and a return measured
  // against nothing is not a percentage.
  const base = soldOut ? holding.invested : cost;
  const gainPct = base > 0 ? (gain / base) * 100 : null;
  const up = gain >= 0;

  const buys = holding.lots.filter((l) => l.kind === 'buy');
  const sells = holding.lots.filter((l) => l.kind === 'sell');
  const boughtE4 = buys.reduce((sum, l) => sum + l.quantityE4, 0);
  // What the units cost on average, across everything ever bought. Kept
  // separate from `cost`, which nets sales off and answers a different question.
  const avgBuy = boughtE4 ? perUnit(holding.invested, boughtE4) : 0;
  // Held from the day the units landed, which for an SIP is not the day the
  // money left the bank.
  const oldest = holding.lots[holding.lots.length - 1];
  const first = oldest ? oldest.allottedAt ?? oldest.occurredAt : null;
  // The days it was actually held, which is what a closed holding's charts
  // are worth drawing over: its line runs on to today at nothing otherwise.
  const dayOf = (l: { allottedAt: string | null; occurredAt: string }) =>
    (l.allottedAt ?? l.occurredAt).slice(0, 10);
  const held = holding.lots.map(dayOf).sort();
  const from = held[0];
  const to = held[held.length - 1];
  // The days it was held, with the tail of nothing taken off: on the day the
  // last units go the holding is worth zero, and a line that ends on the
  // floor reads as a collapse rather than as a sale.
  const toTenure = (line: ValuePoint[]) => {
    if (!soldOut || !from || !to) return line;
    const inside = line.filter((p) => p.asOf >= from && p.asOf <= to);
    let end = inside.length;
    while (end > 0 && inside[end - 1].value === 0) end -= 1;
    return inside.slice(0, end);
  };

  const span = Math.max(cost, holding.marketValue, 1);
  const basePct = (Math.max(Math.min(cost, holding.marketValue), 0) / span) * 100;
  const deltaPct = (Math.abs(holding.marketValue - cost) / span) * 100;

  return (
    <div className="screen">
      <header className="screen-head detail-head">
        <div className="detail-id">
          <button className="detail-back" onClick={onBack} aria-label="Back to investments">
            <Icon name="chevron-left" size={17} />
          </button>
          <span
            className="holding-glyph"
            style={{
              ['--tint' as any]: deposit
                ? 'var(--blue)'
                : holding.kind === 'gold'
                  ? 'var(--amber)'
                  : 'var(--violet)',
            }}
          >
            <Icon
              name={deposit ? 'landmark' : isGold ? 'coins' : 'trending-up'}
              size={18}
            />
          </span>
          <div>
            <h1>{title}</h1>
            <p>
              {detail}
              {holding.closed && ' · closed'}
              {holding.note ? ` · ${holding.note}` : ''}
            </p>
          </div>
        </div>
        <div className="head-actions">
          {isGold ? (
            <Button tone="primary" icon="pencil" onClick={onEdit}>Edit</Button>
          ) : (
            <>
              <Button icon="pencil" onClick={onEdit}>Edit</Button>
              <Button tone="primary" icon="plus" onClick={onAddLot}>
                {deposit
                  ? holding.kind === 'rd'
                    ? 'Add instalment'
                    : 'Add payment'
                  : 'Buy or sell'}
              </Button>
            </>
          )}
        </div>
      </header>

      <Card className="detail-summary">
        <div className="detail-top">
          <div className="detail-hero-main">
            <span className="detail-label">
              {soldOut ? 'Returned' : deposit ? 'Worth today' : 'Market value'}
            </span>
            {soldOut ? (
              <BigMoney value={holding.realised} className="hero-amount" />
            ) : deposit || priced ? (
              <BigMoney value={holding.marketValue} className="hero-amount" />
            ) : (
              <strong className="detail-unpriced">No price fetched yet</strong>
            )}
            <p className="detail-hero-sub">
              {soldOut ? (
                <>
                  {money(holding.invested)} invested
                  {from && to && ` · held ${dayLabel(from)} to ${dayLabel(to)}`}
                </>
              ) : deposit ? (
                <>
                  {money(cost)} paid in
                  {holding.rateE4 ? ` at ${holding.rateE4 / 10_000}% a year` : ''}
                  {holding.maturesOn
                    ? ` · ${money(holding.maturityValue)} on ${dayLabel(holding.maturesOn)}`
                    : ''}
                </>
              ) : (
                <>
                  {quantity(holding.unitsE4, unit)}
                  {priced &&
                    ` at ${unitPrice(holding.priceE4!)} a ${unit === 'g' ? 'gram' : 'unit'}`}
                  {holding.priceAsOf && ` · priced ${dayLabel(holding.priceAsOf)}`}
                </>
              )}
            </p>
          </div>
          {(deposit || priced || soldOut) && !isGold && (
            <div className={`detail-return ${up ? 'is-up' : 'is-down'}`}>
              <small>{soldOut ? 'Realised' : 'Total return'}</small>
              <span>{money(gain, { sign: gain > 0 })}</span>
              {gainPct !== null && <em>{percent(gainPct, { sign: true })}</em>}
            </div>
          )}
        </div>

        {priced && !isGold && !deposit && !soldOut && (
          <div
            className="holding-bar detail-bar"
            title={`Cost ${money(cost)} · now ${money(holding.marketValue)}`}
          >
            <motion.span
              className="holding-bar-base"
              style={{
                ['--tint' as any]: holding.kind === 'gold' ? 'var(--amber)' : 'var(--violet)',
              }}
              initial={{ width: 0 }}
              animate={{ width: `${basePct}%` }}
              transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
            />
            <motion.span
              className={`holding-bar-delta ${up ? 'is-up' : 'is-down'}`}
              initial={{ width: 0 }}
              animate={{ width: `${deltaPct}%` }}
              transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
            />
          </div>
        )}

        <div className="detail-figures">
          <Figure label={isGold ? 'Grams held' : 'Units held'} value={quantity(holding.unitsE4, unit)} />
          {isGold ? (
            <>
              <Figure label="Purity" value={carats(holding.purityE4)} />
              <Figure
                label="Rate"
                value={priced ? unitPrice(holding.priceE4!) : '—'}
                hint="per gram, today"
              />
            </>
          ) : (
            <>
              <Figure
                label="Average cost"
                value={avgBuy ? money(avgBuy, { paise: true }) : '—'}
                hint={`per ${unit === 'g' ? 'gram' : 'unit'}`}
              />
              <Figure
                label="Invested"
                value={money(holding.invested)}
                hint={`${buys.length} ${buys.length === 1 ? 'purchase' : 'purchases'}`}
              />
              {sells.length > 0 && (
                <Figure
                  label="Realised"
                  value={money(holding.realised)}
                  hint={`${sells.length} ${sells.length === 1 ? 'sale' : 'sales'}`}
                />
              )}
              {!soldOut && <Figure label="Net cost" value={money(cost)} hint="after sales" />}
            </>
          )}
          {share > 0.001 && (
            <Figure label="Allocation" value={percent(share * 100)} hint="of your holdings" />
          )}
          {!isGold && first && (
            <Figure
              label="Held for"
              value={soldOut && from && to ? heldFor(from, to) : heldFor(first)}
              hint={
                soldOut && to ? `until ${dayLabel(to)}` : `since ${dayLabel(first)}`
              }
            />
          )}
          {isGold && (
            <Figure
              label="Held for"
              value={heldFor(holding.acquiredOn ?? holding.createdAt)}
              hint={
                holding.acquiredOn
                  ? `acquired ${dayLabel(holding.acquiredOn)}`
                  : `added to the book ${dayLabel(holding.createdAt)}`
              }
            />
          )}
        </div>
      </Card>

      {/* Money down, units not landed. Said on the page rather than left to
          be worked out from a row that looks short of a figure. */}
      {holding.pending > 0 && (
        <p className="page-note">
          <Icon name="clock" size={13} />
          {money(holding.pending)} paid in and not allotted yet. It is counted at
          what it cost until the units land. Open the entry and put them in when
          your statement shows them.
        </p>
      )}

      {/* What your own holding has been worth, which is a different question
          from what the fund has been worth: this line starts at your first
          purchase, steps up as instalments land, and is the one your money
          is actually riding on. The scheme's NAV follows it below. */}
      {!deposit && (
        <PriceHistory
          title={soldOut ? 'What it was worth' : "What it's worth"}
          hint={
            soldOut
              ? 'your units, over the months you held them'
              : isGold
                ? 'your gold, day by day'
                : 'your units, day by day'
          }
          tint={isGold ? 'var(--amber)' : 'var(--violet)'}
          kind="money"
          // Sold out of: one window is worth drawing, and it is the tenure.
          ranges={!soldOut}
          load={(days) => api.holdingValueSeries(holding.id, days).then(toTenure)}
        />
      )}

      {/* The scheme's own NAV, under the line that is actually yours. Gold
          has no second line to draw here: every piece rides one rate, so the
          rate is plotted once at the top of the gold tab, where a fineness
          can be picked for it. A deposit has none at all — it earns at the
          rate written into its terms, and what it is worth on a day is
          arithmetic rather than a quote. */}
      {!deposit && !isGold && (
        <PriceHistory
          title="NAV"
          ranges={!soldOut}
          hint={soldOut ? 'one unit, while you held it' : 'one unit, day by day'}
          tint="var(--violet)"
          load={(days) =>
            api
              .holdingSeries(holding.id, days)
              .then((line) => toTenure(line.map((p) => ({ asOf: p.asOf, value: p.priceE4 }))))
          }
          reference={avgBuy ? avgBuy * 100 : null}
          referenceLabel={
            avgBuy ? `your average cost · ${money(avgBuy, { paise: true })}` : undefined
          }
          footnote="A scheme’s NAV is published once a day, after the market closes."
        />
      )}

      <div className={`detail-grid ${isGold ? 'is-single' : ''}`}>
        {!isGold && (
        <Card padded={false} className="detail-lots">
          <div className="card-pad">
            <CardHead
              title="History"
              hint={`${holding.lots.length} ${holding.lots.length === 1 ? 'entry' : 'entries'}`}
              action={
                <Button size="sm" icon="plus" onClick={onAddLot}>Add</Button>
              }
            />
          </div>
          {holding.lots.length === 0 ? (
            <div className="card-pad">
              <Empty
                art="growth"
                tone="green"
                title="Nothing recorded yet"
                body="Add what you bought and when."
              />
            </div>
          ) : (
            <motion.ul className="detail-lot-list" variants={listVariants} initial="initial" animate="animate">
              <AnimatePresence initial={false}>
                {holding.lots.map((lot) => (
                  <motion.li key={lot.id} variants={itemVariants} layout="position" transition={spring}>
                    <button className="detail-lot" onClick={() => onEditLot(lot)}>
                      <span className={`lot-mark ${lot.kind === 'sell' ? 'is-sell' : ''}`}>
                        <Icon
                          name={lot.kind === 'buy' ? 'arrow-down-left' : 'arrow-up-right'}
                          size={12}
                          strokeWidth={2.4}
                        />
                      </span>
                      <span className="detail-lot-when">
                        <strong>
                          {lot.quantityE4 <= 0
                            ? 'Paid'
                            : lot.kind === 'buy'
                              ? 'Bought'
                              : 'Sold'}
                        </strong>
                        <span>
                          {dayLabel(lot.allottedAt ?? lot.occurredAt)}
                          {lot.allottedAt
                            ? ` · ${lot.kind === 'buy' ? 'paid' : 'settled'} ${shortDayLabel(lot.occurredAt)}`
                            : ''}
                        </span>
                      </span>
                      {/* Money down, units still to land. Saying "0 units at
                          ₹0" would read as a mistake rather than as a wait. */}
                      <span className="detail-lot-qty">
                        {lot.quantityE4 > 0 ? (
                          <>
                            <strong>{quantity(lot.quantityE4, unit)}</strong>
                            <span>
                              at {money(perUnit(lot.amount, lot.quantityE4), { paise: true })}
                            </span>
                          </>
                        ) : (
                          <>
                            <strong className="is-waiting">Awaiting units</strong>
                            <span>put them in when the statement shows them</span>
                          </>
                        )}
                      </span>
                      <span className="detail-lot-amount">
                        <strong className={lot.kind === 'sell' ? 'is-up' : undefined}>
                          {money(lot.amount, { sign: lot.kind === 'sell' })}
                        </strong>
                        <span>
                          {lot.transactionId ? (
                            <>
                              <Icon name="arrow-left-right" size={10} />
                              {lot.transactionLabel ?? 'Linked'}
                            </>
                          ) : (
                            'off-ledger'
                          )}
                        </span>
                      </span>
                    </button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </Card>
        )}

        <Card className="detail-about">
          <CardHead title="Details" />
          <dl className="detail-facts">
            {holding.kind === 'fund' ? (
              <>
                <Fact label="Posts into" value={holding.accountName ?? 'Not posted to an account'} />
                <Fact label="AMFI scheme" value={holding.schemeCode ?? '—'} mono />
                {holding.isin && <Fact label="ISIN" value={holding.isin} mono />}
              </>
            ) : (
              <>
                <Fact label="Weight" value={quantity(holding.unitsE4, 'g')} />
                <Fact label="Purity" value={`${carats(holding.purityE4)} · ${((holding.purityE4 ?? 10_000) / 10_000 * 100).toFixed(1)}% fine`} />
                <Fact
                  label="Acquired"
                  value={holding.acquiredOn ? dayLabel(holding.acquiredOn) : 'not recorded'}
                />
              </>
            )}
            <Fact
              label="Price"
              value={priced ? `${unitPrice(holding.priceE4!)} a ${unit === 'g' ? 'gram' : 'unit'}` : 'unavailable'}
            />
            {holding.priceAsOf && <Fact label="As of" value={dayLabel(holding.priceAsOf)} />}
            <Fact label="Added" value={dayLabel(holding.createdAt)} />
          </dl>
          {isGold && (
            <p className="detail-note">
              Gold is weighed, not traded: change the grams on the holding itself
              and its value follows. Valued from international spot, converted at
              the ECB's rupee rate and marked up for duty and GST. That markup is
              yours to set in Settings.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="detail-figure">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="detail-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'is-mono' : undefined}>{value}</dd>
    </div>
  );
}
