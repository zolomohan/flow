import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { Button, Card, CardHead, Empty } from '../components/ui';
import {
  dayLabel, money, percent, perUnit, quantity, shortDayLabel, unitPrice,
} from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Holding, InvestmentLot } from '../lib/types';

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
function heldFor(since: string) {
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
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
  // Gold is weight and today's price. There is no purchase history behind it
  // and no cost to measure a return against, so both are left off.
  const isGold = holding.kind === 'gold';

  const gain = holding.totalReturn;
  const cost = holding.invested - holding.realised;
  const gainPct = cost > 0 ? (gain / cost) * 100 : null;
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
              ['--tint' as any]: holding.kind === 'gold' ? 'var(--amber)' : 'var(--violet)',
            }}
          >
            <Icon name={isGold ? 'coins' : 'trending-up'} size={18} />
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
              <Button tone="primary" icon="plus" onClick={onAddLot}>Buy or sell</Button>
            </>
          )}
        </div>
      </header>

      <Card className="detail-summary">
        <div className="detail-top">
          <div className="detail-hero-main">
            <span className="detail-label">Market value</span>
            {priced ? (
              <BigMoney value={holding.marketValue} className="hero-amount" />
            ) : (
              <strong className="detail-unpriced">No price fetched yet</strong>
            )}
            <p className="detail-hero-sub">
              {quantity(holding.unitsE4, unit)}
              {priced && ` at ${unitPrice(holding.priceE4!)} a ${unit === 'g' ? 'gram' : 'unit'}`}
              {holding.priceAsOf && ` · priced ${dayLabel(holding.priceAsOf)}`}
            </p>
          </div>
          {priced && !isGold && (
            <div className={`detail-return ${up ? 'is-up' : 'is-down'}`}>
              <small>Total return</small>
              <span>{money(gain, { sign: gain > 0 })}</span>
              {gainPct !== null && <em>{percent(gainPct, { sign: true })}</em>}
            </div>
          )}
        </div>

        {priced && !isGold && (
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
              <Figure label="Purity" value={carats(holding.purityE4)} hint="what it is scaled by" />
              <Figure
                label="Rate"
                value={priced ? unitPrice(holding.priceE4!) : '—'}
                hint="a gram today"
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
              <Figure label="Net cost" value={money(cost)} hint="what you are in for" />
            </>
          )}
          {share > 0.001 && (
            <Figure label="Allocation" value={percent(share * 100)} hint="of your holdings" />
          )}
          {!isGold && first && (
            <Figure label="Held for" value={heldFor(first)} hint={`since ${dayLabel(first)}`} />
          )}
          {isGold && (
            <Figure label="Added" value={heldFor(holding.createdAt)} hint={`on ${dayLabel(holding.createdAt)}`} />
          )}
        </div>
      </Card>

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
                icon="inbox"
                title="Nothing recorded yet"
                body="Add what you bought and when, and this becomes the position's full history."
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
                        <strong>{lot.kind === 'buy' ? 'Bought' : 'Sold'}</strong>
                        <span>
                          {dayLabel(lot.allottedAt ?? lot.occurredAt)}
                          {lot.allottedAt
                            ? ` · ${lot.kind === 'buy' ? 'paid' : 'settled'} ${shortDayLabel(lot.occurredAt)}`
                            : ''}
                        </span>
                      </span>
                      <span className="detail-lot-qty">
                        <strong>{quantity(lot.quantityE4, unit)}</strong>
                        <span>at {money(perUnit(lot.amount, lot.quantityE4), { paise: true })}</span>
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
              the ECB's rupee rate and marked up for duty and GST — that markup is
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
