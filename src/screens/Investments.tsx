import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkline } from '../components/charts';
import { Icon } from '../components/Icon';
import { PriceHistory } from '../components/PriceHistory';
import { Button, Card, Empty, Segmented, Sheet, type SegmentOption } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { dayLabel, money, percent, perUnit, quantity, shortDayLabel, unitPrice } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { carats, HoldingDetail, splitName, unitOf } from './HoldingDetail';
import { isDeposit } from '../lib/types';
import type {
  Holding, HoldingKind, InvestmentTab, InvestmentLot, ValuePoint,
} from '../lib/types';

/** How much of each line the cards carry. A year is the read most people
 *  have in mind when they glance at a holding. */
const CARD_DAYS = 366;

/**
 * The two kinds are read differently — a fund against what it cost, gold
 * against what it weighs — so they get a tab each rather than being stacked
 * into one scroll where the totals would have to hedge.
 */
const TABS: SegmentOption<InvestmentTab>[] = [
  { value: 'fund', label: 'Mutual funds', icon: 'trending-up', accent: 'var(--violet)' },
  { value: 'gold', label: 'Gold', icon: 'coins', accent: 'var(--amber)' },
  { value: 'deposit', label: 'Deposits', icon: 'landmark', accent: 'var(--blue)' },
];

const BLURBS: Record<InvestmentTab, string> = {
  fund: 'Units valued at their latest NAV.',
  gold: "Weighed by the gram, valued at today's rate.",
  deposit:
    'Fixed and recurring deposits, earning at the rate you were quoted — compounded quarterly, and stopping at maturity.',
};

/** Which finenesses the rate can be read at. Jewellery is bought at 22K, so
 *  that is the rate worth quoting; 24K is what the market itself trades. */
const RATE_PURITIES: SegmentOption<string>[] = [
  { value: '9160', label: '22K' },
  { value: '10000', label: '24K' },
];

const TINTS: Record<InvestmentTab, string> = {
  fund: 'var(--violet)',
  gold: 'var(--amber)',
  deposit: 'var(--blue)',
};

export function Investments({
  initialTab = 'fund', onNewHolding, onEditHolding, onAddLot, onEditLot,
}: {
  /** Which tab to open on, for arrivals from elsewhere in the app. */
  initialTab?: InvestmentTab;
  onNewHolding: (kind: HoldingKind) => void;
  onEditHolding: (holding: Holding) => void;
  onAddLot: (holding: Holding) => void;
  onEditLot: (holding: Holding, lot: InvestmentLot) => void;
}) {
  const { holdings, refreshPrices, pricesRefreshing, revision } = useStore();
  const [tab, setTab] = useState<InvestmentTab>(initialTab);
  const [showClosed, setShowClosed] = useState(false);
  // Every card's line, fetched in one call rather than one per card. Empty
  // until prices have been fetched at least once, which the cards say plainly.
  const [series, setSeries] = useState<Record<string, PricePoint[]>>({});
  // Which purity the gold rate is read at. Every piece rides the same market,
  // so the tab plots it once and this says at what fineness.
  // Which pieces the tab's line counts. Null is all of them.
  const [purity, setPurity] = useState<number | null>(null);
  // Held by id rather than by object: the store hands back fresh holdings
  // after every write, and the open page should follow them.
  const [openId, setOpenId] = useState<string | null>(null);

  // A book that predates the price history — or one whose prices were last
  // fetched before it existed — has holdings but no lines to draw. Ask for
  // prices once in that case: a refresh backfills every line it can, and the
  // guard means it happens the once rather than on every render.
  const backfilled = useRef(false);
  useEffect(() => {
    let live = true;
    api
      .holdingValueSeriesAll(CARD_DAYS)
      .then((lines) => {
        if (!live) return;
        setSeries(lines);
        const bare = Object.values(lines).every((line) => line.length < 2);
        if (bare && holdings.length && !backfilled.current) {
          backfilled.current = true;
          void refreshPrices();
        }
      })
      // Nothing came back, so the cards stop waiting and say so themselves.
      .catch(() => live && setSeries({}));
    return () => {
      live = false;
    };
  }, [revision, holdings.length, refreshPrices]);

  // The rate behind the gold tile, at whatever fineness it is being read at.
  // Only the gold tab asks: nothing else on the screen quotes a gram.
  useEffect(() => {
    if (tab !== 'gold') return;
    let live = true;
    api
      .goldRateSeries(CARD_DAYS, ratePurity)
      .then((line) => live && setRateLine(line.map((p) => ({ asOf: p.asOf, value: p.priceE4 }))))
      .catch(() => live && setRateLine([]));
    return () => {
      live = false;
    };
  }, [tab, ratePurity, revision]);

  const viewing = openId ? holdings.find((h) => h.id === openId) ?? null : null;
  // Everything worth something, across both tabs — the one figure that has to
  // stay whole, since it is what the rest of the app calls your investments.
  const portfolio = holdings
    .filter((h) => !h.closed)
    .reduce((sum, h) => sum + h.marketValue, 0);

  // What the tab's "add" button makes. Deposits open as fixed — the sheet
  // itself offers recurring, which is where the difference matters.
  const newKind: HoldingKind = tab === 'deposit' ? 'fd' : tab;

  // The deposits tab holds both kinds of them; the others hold their own.
  const mine = useMemo(
    () =>
      holdings.filter((h) =>
        tab === 'deposit' ? isDeposit(h.kind) : h.kind === tab,
      ),
    [holdings, tab],
  );
  const open = useMemo(() => mine.filter((h) => !h.closed), [mine]);
  const closed = useMemo(() => mine.filter((h) => h.closed), [mine]);

  const value = open.reduce((sum, h) => sum + h.marketValue, 0);
  // Cost and return are a fund's story. Gold was weighed, not bought, so it
  // carries no basis, and its tab counts grams instead.
  const invested = open.reduce((sum, h) => sum + h.invested - h.realised, 0);
  const gain = open.reduce((sum, h) => sum + h.totalReturn, 0);
  const gainPct = invested > 0 ? (gain / invested) * 100 : null;
  const grams = open.reduce((sum, h) => sum + h.unitsE4, 0);
  // What a gram of pure gold goes for today. Every holding's price is that
  // figure scaled by its purity, so any priced one gives it back.
  const pureRate = (() => {
    const any = open.find((h) => h.priceE4 !== null && h.purityE4);
    return any ? Math.round((any.priceE4! * 10_000) / any.purityE4!) : null;
  })();
  // The tile quotes that rate at the fineness being read. With nothing priced
  // there is still the line to fall back on — the market has a rate today
  // whether or not any piece here carries one.
  const rate =
    pureRate !== null
      ? Math.round((pureRate * ratePurity) / 10_000)
      : rateLine?.length
        ? rateLine[rateLine.length - 1].value
        : null;
  const rateMove =
    rateLine && rateLine.length > 1
      ? rateLine[rateLine.length - 1].value - rateLine[0].value
      : 0;

  // Pieces of one fineness can be read on their own, but only where there is
  // more than one to tell apart — a locker of 22K bangles has nothing to
  // filter.
  const purities = useMemo(() => {
    const held = open.map((h) => h.purityE4 ?? 10_000);
    return [...new Set(held)].sort((a, b) => b - a);
  }, [open]);

  // The freshest price anything on this tab is carrying, and whether anything
  // is missing one — an unpriced holding is left out of every total above. A
  // deposit is computed from its own rate, never quoted, so it is never
  // waiting on a price.
  const priced = open.map((h) => h.priceAsOf).filter((d): d is string => !!d).sort();
  const asOf = priced.length ? priced[priced.length - 1] : undefined;
  const unpriced = open.filter((h) => !isDeposit(h.kind) && !h.priceE4).length;

  if (viewing) {
    return (
      <HoldingDetail
        holding={viewing}
        share={portfolio > 0 ? viewing.marketValue / portfolio : 0}
        onBack={() => setOpenId(null)}
        onEdit={() => onEditHolding(viewing)}
        onAddLot={() => onAddLot(viewing)}
        onEditLot={(lot) => onEditLot(viewing, lot)}
      />
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Investments</h1>
          <p>
            {holdings.length
              ? `Worth ${money(portfolio)} · ${BLURBS[tab]}`
              : 'Gold and mutual funds, valued at what they would fetch today.'}
          </p>
        </div>
        <div className="head-actions">
          <Button
            icon="refresh-cw"
            onClick={() => refreshPrices()}
            disabled={pricesRefreshing || !holdings.length}
          >
            {pricesRefreshing ? 'Fetching…' : 'Refresh prices'}
          </Button>
          <Button tone="primary" icon="plus" onClick={() => onNewHolding(newKind)}>
            {tab === 'gold' ? 'Add gold' : tab === 'deposit' ? 'Add a deposit' : 'Add a fund'}
          </Button>
        </div>
      </header>

      {holdings.length > 0 && (
        <div className="screen-tabs">
          <Segmented options={TABS} value={tab} onChange={setTab} name="investment-tab" />
        </div>
      )}

      {holdings.length === 0 ? (
        <Card>
          <Empty
            icon="piggy-bank"
            title="Nothing tracked yet"
            body="Add gold by the gram, or a mutual fund by its scheme. Midas fetches the price and values it alongside your accounts."
            action={
              <div className="welcome-actions">
                <Button icon="trending-up" tone="primary" onClick={() => onNewHolding('fund')}>
                  Add a fund
                </Button>
                <Button icon="coins" onClick={() => onNewHolding('gold')}>
                  Add gold
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            className="tab-panel"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
          >
            {open.length > 0 && (
              <div className="holding-summary">
                <div className="holding-total">
                  <span>Market value</span>
                  <strong>{money(value)}</strong>
                  <small>
                    {tab === 'deposit'
                      ? 'with the interest earned so far'
                      : asOf
                        ? `priced ${dayLabel(asOf)}`
                        : 'no prices fetched yet'}
                  </small>
                </div>
                {tab === 'gold' ? (
                  <>
                    <div className="holding-total">
                      <span>Weight</span>
                      <strong>{quantity(grams, 'g')}</strong>
                      <small>
                        across {open.length} {open.length === 1 ? 'piece' : 'pieces'}
                      </small>
                    </div>
                    {/* A rate is a fact about the market rather than about
                        any piece, so the tile carries its own year and opens
                        the whole line rather than only quoting today. */}
                    <button
                      type="button"
                      className="holding-total is-rate"
                      onClick={() => setRateOpen(true)}
                    >
                      <div className="rate-figure">
                        <span>Rate</span>
                        <strong>{rate ? unitPrice(rate) : '—'}</strong>
                        <small>a gram of {carats(ratePurity)}</small>
                      </div>
                      {(rateLine === null || rateLine.length > 1) && (
                        <div className="rate-line">
                          <Sparkline
                            values={rateLine?.map((p) => p.value) ?? []}
                            height={46}
                            loading={rateLine === null}
                            stroke={rateMove >= 0 ? 'var(--green)' : 'var(--red)'}
                          />
                        </div>
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="holding-total">
                      <span>Invested</span>
                      <strong>{money(invested)}</strong>
                      <small>cost, less what selling returned</small>
                    </div>
                    <div className={`holding-total ${gain >= 0 ? 'is-up' : 'is-down'}`}>
                      <span>Return</span>
                      <strong>{money(gain, { sign: gain > 0 })}</strong>
                      <small>
                        {gainPct === null
                          ? 'folded into your net worth'
                          : `${percent(gainPct, { sign: true })} overall`}
                      </small>
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === 'gold' && open.length > 0 && (
              <PriceHistory
                title="Your gold"
                hint={
                  purity === null
                    ? 'what the metal you hold has been worth, day by day'
                    : `what your ${carats(purity)} has been worth, day by day`
                }
                tint="var(--amber)"
                kind="money"
                load={(days) => api.goldValueSeries(days, purity)}
                reloadOn={purity ?? 'all'}
                filter={
                  purities.length > 1 ? (
                    <Segmented
                      options={[
                        { value: 'all', label: 'All' },
                        ...purities.map((p) => ({ value: String(p), label: carats(p) })),
                      ]}
                      value={purity === null ? 'all' : String(purity)}
                      onChange={(next) => setPurity(next === 'all' ? null : Number(next))}
                      size="sm"
                      name="gold-purity"
                    />
                  ) : undefined
                }
                footnote="Each piece counted from the day it was acquired, at the weight it is today, over London's daily fix — converted at the ECB's rupee rate and marked up for duty and GST."
              />
            )}

            {unpriced > 0 && (
              <Card className="price-warning">
                <Icon name="alert-circle" size={16} />
                <span>
                  {unpriced === 1 ? 'One holding has' : `${unpriced} holdings have`} no price yet, so
                  {unpriced === 1 ? ' it is' : ' they are'} left out of the totals and your net worth.
                  {' '}Try refreshing once you are online.
                </span>
              </Card>
            )}

            {open.length === 0 ? (
              <Card>
                <Empty
                  icon={tab === 'gold' ? 'coins' : 'trending-up'}
                  title={tab === 'gold' ? 'No gold tracked' : 'No funds tracked'}
                  body={
                    tab === 'gold'
                      ? 'Weigh what you have — coins, a chain, bangles — and Midas values it at the day’s rate.'
                      : 'Add a scheme and record what you have bought. Midas fetches its NAV each day.'
                  }
                  action={
                    <Button tone="primary" icon="plus" onClick={() => onNewHolding(newKind)}>
                      {tab === 'gold'
                        ? 'Add gold'
                        : tab === 'deposit'
                          ? 'Add a deposit'
                          : 'Add a fund'}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <motion.div
                className="holding-cards"
                variants={listVariants}
                initial="initial"
                animate="animate"
              >
                {open.map((holding) => (
                  <HoldingCard
                    key={holding.id}
                    holding={holding}
                    tint={TINTS[tab]}
                    line={series?.[holding.id] ?? []}
                    loading={series === null}
                    share={portfolio > 0 ? holding.marketValue / portfolio : 0}
                    onOpen={() => setOpenId(holding.id)}
                  />
                ))}
              </motion.div>
            )}

            {closed.length > 0 && (
              <section className="account-group">
                <button className="archived-toggle" onClick={() => setShowClosed((c) => !c)}>
                  <motion.span animate={{ rotate: showClosed ? 90 : 0 }} transition={spring}>
                    <Icon name="chevron-right" size={15} />
                  </motion.span>
                  Closed · {closed.length}
                </button>
                <AnimatePresence initial={false}>
                  {showClosed && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={spring}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="holding-cards">
                        {closed.map((holding) => (
                          <HoldingCard
                            key={holding.id}
                            holding={holding}
                            tint="var(--ink-4)"
                            line={series?.[holding.id] ?? []}
                            loading={series === null}
                            share={0}
                            onOpen={() => setOpenId(holding.id)}
                          />
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )}

            {asOf && (
              <p className="price-footnote">
                {tab === 'gold'
                  ? `Spot gold, converted at the ECB’s rupee rate and marked up for duty and GST. Last priced ${dayLabel(asOf)}.`
                  : `NAVs come from AMFI, published once a day. Last priced ${dayLabel(asOf)}.`}
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      {/* The rate on its own, at either fineness — the tile quotes one number
          and this is the year behind it. */}
      <Sheet
        open={rateOpen && tab === 'gold'}
        onClose={() => setRateOpen(false)}
        title="Gold rate"
        subtitle="what a gram has gone for"
        width={620}
      >
        <PriceHistory
          title={`A gram of ${carats(ratePurity)}`}
          hint="the rate every piece is valued at"
          tint="var(--amber)"
          load={(days) =>
            api
              .goldRateSeries(days, ratePurity)
              .then((line) => line.map((p) => ({ asOf: p.asOf, value: p.priceE4 })))
          }
          reloadOn={ratePurity}
          filter={
            <Segmented
              options={RATE_PURITIES}
              value={String(ratePurity)}
              onChange={(next) => setRatePurity(Number(next))}
              size="sm"
              name="rate-purity"
            />
          }
          footnote="Spot gold, converted at the ECB’s rupee rate and marked up for duty and GST."
        />
      </Sheet>
    </div>
  );
}

/**
 * One card per holding: what it is, what it is worth, what its price has been
 * doing for a year, and the three or four figures you would otherwise have to
 * open the holding to read. Everything past that — the lot history, the ledger
 * links, the full chart — still lives one click away on its own page.
 */
function HoldingCard({
  holding, tint, line, share, onOpen, loading = false,
}: {
  holding: Holding;
  tint: string;
  /** What this holding of yours has been worth over the card window, oldest
   *  first. */
  line: ValuePoint[];
  /** Whether that line is still being read, rather than known to be short. */
  loading?: boolean;
  /** Its slice of everything held, 0–1. */
  share: number;
  onOpen: () => void;
}) {
  const unit = unitOf(holding);
  const { title, detail } = splitName(holding);
  const priced = holding.priceE4 !== null;
  const isGold = holding.kind === 'gold';

  const gain = holding.totalReturn;
  const cost = holding.invested - holding.realised;
  const gainPct = cost > 0 ? (gain / cost) * 100 : null;
  const buys = holding.lots.filter((l) => l.kind === 'buy');
  const boughtE4 = buys.reduce((sum, l) => sum + l.quantityE4, 0);
  const avgBuy = boughtE4 ? perUnit(holding.invested, boughtE4) : 0;

  // Which way the holding has gone over the window — what it is worth now
  // against what it was worth then, instalments and all.
  const move = line.length > 1 ? line[line.length - 1].value - line[0].value : 0;
  const up = gain >= 0;

  // The rate is already under the value on a gold card, so its third figure
  // goes to something the card doesn't otherwise say.
  const deposit = isDeposit(holding.kind);
  const figures: { label: string; value: string; hint?: string }[] = deposit
    ? [
        { label: 'Paid in', value: money(cost) },
        {
          label: 'Rate',
          value: holding.rateE4 ? `${holding.rateE4 / 10_000}%` : '—',
          hint: 'a year',
        },
        {
          label: 'At maturity',
          value: holding.maturityValue ? money(holding.maturityValue) : '—',
          hint: holding.maturesOn ? shortDayLabel(holding.maturesOn) : undefined,
        },
        { label: 'Earned', value: money(gain, { sign: gain > 0 }), hint: 'so far' },
      ]
    : isGold
    ? [
        { label: 'Weight', value: quantity(holding.unitsE4, unit) },
        { label: 'Purity', value: carats(holding.purityE4) },
        {
          label: 'Share',
          value: share > 0.0005 ? percent(share * 100) : '—',
          hint: 'of holdings',
        },
      ]
    : [
        { label: 'Units', value: quantity(holding.unitsE4, '') },
        { label: 'NAV', value: priced ? unitPrice(holding.priceE4!) : '—', hint: 'a unit' },
        {
          label: 'Avg cost',
          value: avgBuy ? money(avgBuy, { paise: true }) : '—',
          hint: 'a unit',
        },
        { label: 'Invested', value: money(cost), hint: 'net of sales' },
      ];

  const footnotes = deposit
    ? [
        holding.closed ? 'closed' : null,
        holding.kind === 'fd' ? 'fixed deposit' : 'recurring deposit',
        holding.openedOn ? `opened ${shortDayLabel(holding.openedOn)}` : null,
        holding.lots.length
          ? `${holding.lots.length} ${holding.lots.length === 1 ? 'payment' : 'payments'}`
          : 'nothing paid in yet',
        holding.accountName,
      ].filter(Boolean)
    : [
        holding.closed ? 'closed' : null,
        isGold && holding.acquiredOn ? `since ${shortDayLabel(holding.acquiredOn)}` : null,
        !isGold && share > 0.001 ? `${percent(share * 100)} of holdings` : null,
        !isGold && holding.lots.length
          ? `${holding.lots.length} ${holding.lots.length === 1 ? 'entry' : 'entries'}`
          : null,
        holding.accountName,
        holding.priceAsOf ? `priced ${dayLabel(holding.priceAsOf)}` : 'never priced',
      ].filter(Boolean);

  return (
    <motion.button
      type="button"
      variants={itemVariants}
      className={`holding-card ${holding.closed ? 'is-closed' : ''}`}
      style={{ ['--tint' as any]: tint }}
      onClick={onOpen}
      whileTap={{ scale: 0.995 }}
    >
      <span className="hc-head">
        <span className="holding-glyph">
          <Icon
            name={deposit ? 'landmark' : isGold ? 'coins' : 'trending-up'}
            size={17}
          />
        </span>
        <span className="hc-id">
          <span className="holding-name">{title}</span>
          {detail && <span className="holding-held">{detail}</span>}
        </span>
        <span className="holding-chevron">
          <Icon name="chevron-right" size={16} />
        </span>
      </span>

      <span className="hc-body">
        <span className="hc-worth">
          <small>{deposit ? 'Worth today' : 'Market value'}</small>
          <strong>
            {deposit || priced ? money(holding.marketValue) : 'No price yet'}
          </strong>
          {deposit ? (
            <span className={`hc-move ${gain > 0 ? 'is-up' : 'is-quiet'}`}>
              {gain > 0 ? (
                <>
                  <Icon name="arrow-up-right" size={13} strokeWidth={2.4} />
                  {money(gain)} earned
                </>
              ) : (
                'nothing paid in yet'
              )}
            </span>
          ) : isGold ? (
            <span className="hc-move is-quiet">
              {priced ? `at ${unitPrice(holding.priceE4!)} a gram` : 'refresh prices to value it'}
            </span>
          ) : gainPct !== null ? (
            <span className={`hc-move ${up ? 'is-up' : 'is-down'}`}>
              <Icon name={up ? 'arrow-up-right' : 'arrow-down-left'} size={13} strokeWidth={2.4} />
              {percent(gainPct, { sign: true })}
              <em>{money(gain, { sign: gain > 0 })} on cost</em>
            </span>
          ) : (
            <span className="hc-move is-quiet">
              {priced ? 'nothing was paid for these units' : 'refresh prices to value it'}
            </span>
          )}
        </span>

        {!isGold && !deposit && (
          <span className="hc-line">
            {loading ? (
              <Sparkline values={[]} height={56} loading />
            ) : line.length > 1 ? (
              <>
                <Sparkline
                  values={line.map((p) => p.value)}
                  height={56}
                  stroke={move >= 0 ? 'var(--green)' : 'var(--red)'}
                />
                {/* The window the line covers, rather than its last price —
                    the NAV is already among the figures below. */}
                <span className="hc-line-foot">
                  <i>{shortDayLabel(line[0].asOf)}</i>
                  <i>{shortDayLabel(line[line.length - 1].asOf)}</i>
                </span>
              </>
            ) : (
              <span className="hc-line-empty">
                {priced ? 'Its line builds as NAVs are fetched' : 'No NAV fetched yet'}
              </span>
            )}
          </span>
        )}
      </span>

      <span className="hc-figures">
        {figures.map((figure) => (
          <span className="hc-figure" key={figure.label}>
            <span>{figure.label}</span>
            <strong>{figure.value}</strong>
            {figure.hint && <small>{figure.hint}</small>}
          </span>
        ))}
      </span>

      <span className="hc-foot">{footnotes.join(' · ')}</span>
    </motion.button>
  );
}
