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
 * The three kinds are read differently — a fund against what it cost, gold
 * against what it weighs, a deposit against its own rate — so each has a line
 * of its own in the sidebar rather than being stacked into one scroll where
 * the totals would have to hedge. This screen draws whichever it is sent.
 */
const TITLES: Record<InvestmentTab, string> = {
  fund: 'Mutual funds',
  gold: 'Gold',
  deposit: 'Deposits',
};

const BLURBS: Record<InvestmentTab, string> = {
  fund: 'Units valued at their latest NAV.',
  gold: "Weighed by the gram, valued at today's rate.",
  deposit: 'Fixed and recurring deposits, earning until they mature.',
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
  tab, onNewHolding, onEditHolding, onAddLot, onEditLot, focusId, onFocusBack,
}: {
  /** A holding to open straight onto, from the Investments page. */
  focusId?: string | null;
  /** Where that holding's back goes: the page it was opened from. */
  onFocusBack?: () => void;
  /** Which sleeve this is: the route says, and the sidebar shows which. */
  tab: InvestmentTab;
  onNewHolding: (kind: HoldingKind) => void;
  onEditHolding: (holding: Holding) => void;
  onAddLot: (holding: Holding) => void;
  onEditLot: (holding: Holding, lot: InvestmentLot) => void;
}) {
  const { holdings, refreshPrices, pricesRefreshing, revision } = useStore();
  const [showClosed, setShowClosed] = useState(false);
  // Every card's line, fetched in one call rather than one per card. What the
  // holding of yours has been worth, not what the scheme has: a card is about
  // your money, and a NAV line that ran for years before you bought any says
  // nothing about it. Empty until prices have been fetched at least once,
  // which the cards say plainly.
  const [series, setSeries] = useState<Record<string, ValuePoint[]> | null>(null);
  // Which purity the gold rate is read at. Every piece rides the same market,
  // so the tab plots it once and this says at what fineness.
  // Which pieces the tab's line counts. Null is all of them.
  const [purity, setPurity] = useState<number | null>(null);
  // The fineness the rate tile quotes, and the line behind it. 22K by
  // default: it is what a jeweller quotes and what most of a locker is, even
  // though the market itself trades pure metal.
  const [ratePurity, setRatePurity] = useState(9_160);
  const [rateLine, setRateLine] = useState<ValuePoint[] | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  // Held by id rather than by object: the store hands back fresh holdings
  // after every write, and the open page should follow them.
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);

  // A book that predates the price history — or one whose prices were last
  // fetched before it existed — has holdings but no lines to draw. Ask for
  // prices once in that case: a refresh backfills every line it can, and the
  // guard means it happens the once rather than on every render.
  const backfilled = useRef(false);
  useEffect(() => {
    let live = true;
    // The year for everything, and the whole line for anything closed. A
    // holding sold out of two years ago has nothing inside a one-year window,
    // and a card that says "a line appears once prices are fetched" about a
    // fund with three thousand prices behind it is blaming the wrong thing.
    const shut = holdings.filter((h) => h.closed).map((h) => h.id);
    Promise.all([
      api.holdingValueSeriesAll(CARD_DAYS),
      shut.length
        ? api.holdingValueSeriesAll(null)
        : Promise.resolve({} as Record<string, ValuePoint[]>),
    ])
      .then(([recent, everything]) => {
        if (!live) return;
        const lines = { ...recent };
        for (const id of shut) {
          if (everything[id]?.length) lines[id] = everything[id];
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        onBack={() => (focusId && openId === focusId && onFocusBack ? onFocusBack() : setOpenId(null))}
        onEdit={() => onEditHolding(viewing)}
        onAddLot={() => onAddLot(viewing)}
        onEditLot={(lot) => onEditLot(viewing, lot)}
      />
    );
  }

  /* The same empty page whether the book holds nothing at all or only
     nothing of this kind: each sleeve has its own line in the sidebar now,
     so each says what it would hold. */
  const sleeveEmpty = (
    <Empty
      screen
      art={tab === 'gold' ? 'gold' : tab === 'deposit' ? 'bank' : 'growth'}
      tone={tab === 'gold' ? 'amber' : tab === 'deposit' ? 'blue' : 'green'}
      title={
        tab === 'gold'
          ? 'No gold tracked'
          : tab === 'deposit'
            ? 'No deposits tracked'
            : 'No funds tracked'
      }
      body={
        tab === 'gold'
          ? 'Coins, a chain, bangles: weighed, and valued at the day’s rate.'
          : tab === 'deposit'
            ? 'A fixed or recurring deposit: its rate and dates, and what it earns until it matures.'
            : 'Add a scheme and what you bought. Its NAV is fetched daily.'
      }
    />
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>{TITLES[tab]}</h1>
          <p>
            {holdings.length === 0
              ? 'Gold and mutual funds, valued at what they would fetch today.'
              : mine.length
                ? `Worth ${money(value)} · ${BLURBS[tab]}`
                : BLURBS[tab]}
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

      {holdings.length === 0 ? (
        sleeveEmpty
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
                    ? 'your gold, day by day'
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
                footnote="Priced at the daily gold rate in rupees, including duty and GST."
              />
            )}

            {tab === 'fund' && open.length > 0 && (
              <PriceHistory
                title="Your funds"
                hint="your units, day by day"
                tint="var(--violet)"
                kind="money"
                load={(days) => api.sleeveValueSeries('fund', days)}
                footnote="Counted from the day each purchase was allotted, at that day's NAV."
              />
            )}

            {tab === 'deposit' && open.length > 0 && (
              <PriceHistory
                title="Your deposits"
                hint="what you have put in, and what it has earned"
                tint="var(--blue)"
                kind="money"
                load={(days) => api.sleeveValueSeries('deposit', days)}
                footnote="Compounded quarterly at the rate you were quoted, up to maturity."
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
              sleeveEmpty
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
              /* The same fold the settled debts and the Siri history use:
                 a thing you have finished with, kept because it is the only
                 place this sleeve's history can be read. */
              <section className="fold">
                <button
                  type="button"
                  className={`fold-head ${showClosed ? 'is-open' : ''}`}
                  onClick={() => setShowClosed((c) => !c)}
                  aria-expanded={showClosed}
                >
                  <motion.span animate={{ rotate: showClosed ? 90 : 0 }} transition={spring}>
                    <Icon name="chevron-right" size={15} />
                  </motion.span>
                  <strong>Closed</strong>
                  <span className="fold-count">
                    {closed.length} {closed.length === 1 ? 'holding' : 'holdings'}
                  </span>
                  <em>{money(closed.reduce((sum, h) => sum + h.realised, 0))} realised</em>
                </button>

                <motion.div
                  className="fold-body"
                  initial={false}
                  // In the page either way, so `auto` is a height that can be
                  // measured when the fold is asked to open.
                  animate={{ height: showClosed ? 'auto' : 0 }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  aria-hidden={!showClosed}
                  inert={!showClosed}
                >
                  <div className="fold-inner">
                    {/* The cards carry an entrance variant, and a variant
                        only acts on a child that inherits the label naming
                        it — so the list says the words itself rather than
                        leaving them at the opacity the variant starts on. */}
                    <motion.div
                      className="holding-cards"
                      variants={listVariants}
                      initial="initial"
                      animate="animate"
                    >
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
                    </motion.div>
                  </div>
                </motion.div>
              </section>
            )}

            {/* Only gold explains itself: a spot price converted and marked
                up is arithmetic worth showing your working for. Where a NAV
                comes from is not something the tab has to keep saying. */}
            {asOf && tab === 'gold' && (
              <p className="price-footnote">
                Spot gold, converted at the ECB’s rupee rate and marked up for duty
                and GST. Last priced {dayLabel(asOf)}.
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
          hint="used to value your gold"
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
          footnote="Spot gold in rupees, including duty and GST."
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
/**
 * A holding's line over the days it was actually held.
 *
 * Bounded by its first and last entry, and with the tail of nothing taken
 * off: on the day the last units go, the holding is worth zero, and a line
 * that ends on the floor reads as a collapse rather than as a sale.
 */
function whileHeld(line: ValuePoint[], from: string, to: string) {
  const inside = line.filter((p) => p.asOf >= from && p.asOf <= to);
  let end = inside.length;
  while (end > 0 && inside[end - 1].value === 0) end -= 1;
  return inside.slice(0, end);
}

/** How long something was held, in the coarsest unit that still says it. */
function monthsBetween(from: string, to: string) {
  const days = Math.max(
    0,
    Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000),
  );
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const years = months / 12;
  return `${years.toFixed(years < 10 ? 1 : 0)} years`;
}

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

  const deposit = isDeposit(holding.kind);

  // A position that has been sold out of. Its market value is nothing, its
  // NAV is somebody else's business now, and the only figures that still mean
  // anything are what went in, what came back, and the difference.
  const soldOut = holding.closed && !isGold && !deposit;
  const realisedGain = holding.realised - holding.invested;
  const realisedPct =
    holding.invested > 0 ? (realisedGain / holding.invested) * 100 : null;

  // The days it was actually held, from the first entry to the last. A closed
  // holding's line runs on to today at nothing, and a chart that spends most
  // of its width along the floor says nothing about the years above it.
  const days = holding.lots.map((l) => l.occurredAt.slice(0, 10)).sort();
  const from = days[0];
  const to = days[days.length - 1];
  const held = soldOut && from && to ? whileHeld(line, from, to) : line;
  const heldFor = from && to ? monthsBetween(from, to) : null;

  // Which way the holding has gone over the window — what it is worth now
  // against what it was worth then, instalments and all.
  const move = held.length > 1 ? held[held.length - 1].value - held[0].value : 0;
  const up = (soldOut ? realisedGain : gain) >= 0;

  // The rate is already under the value on a gold card, so its third figure
  // goes to something the card doesn't otherwise say.
  const figures: { label: string; value: string; hint?: string }[] = soldOut
    ? [
        { label: 'Invested', value: money(holding.invested) },
        { label: 'Returned', value: money(holding.realised) },
        {
          label: realisedGain >= 0 ? 'Profit' : 'Loss',
          value: money(Math.abs(realisedGain)),
          hint: realisedPct !== null ? percent(Math.abs(realisedPct)) : undefined,
        },
        {
          label: 'Held',
          value: heldFor ?? '—',
          hint: to ? `to ${shortDayLabel(to)}` : undefined,
        },
      ]
    : deposit
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
          <small>{soldOut ? 'Returned' : deposit ? 'Worth today' : 'Market value'}</small>
          <strong>
            {soldOut
              ? money(holding.realised)
              : deposit || priced
                ? money(holding.marketValue)
                : 'No price yet'}
          </strong>
          {soldOut ? (
            <span className={`hc-move ${up ? 'is-up' : 'is-down'}`}>
              <Icon name={up ? 'arrow-up-right' : 'arrow-down-left'} size={13} strokeWidth={2.4} />
              {realisedPct !== null ? percent(realisedPct, { sign: true }) : '—'}
              <em>{money(realisedGain, { sign: realisedGain > 0 })} realised</em>
            </span>
          ) : deposit ? (
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
            ) : held.length > 1 ? (
              <>
                <Sparkline
                  values={held.map((p) => p.value)}
                  height={56}
                  // A holding sold out of is coloured by what it made, not by
                  // where its line happens to end: the last days of one are
                  // the sale, and a sale is not a fall.
                  stroke={
                    (soldOut ? realisedGain : move) >= 0 ? 'var(--green)' : 'var(--red)'
                  }
                />
                {/* The window the line covers, rather than its last price —
                    the NAV is already among the figures below. */}
                <span className="hc-line-foot">
                  <i>{shortDayLabel(held[0].asOf)}</i>
                  <i>{shortDayLabel(held[held.length - 1].asOf)}</i>
                </span>
              </>
            ) : (
              <span className="hc-line-empty">
                {soldOut
                  ? 'No prices from the months it was held'
                  : priced
                    ? 'A line appears once prices are fetched'
                    : 'No NAV fetched yet'}
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
