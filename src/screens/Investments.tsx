import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, Empty, Segmented, type SegmentOption } from '../components/ui';
import { useStore } from '../lib/store';
import { dayLabel, money, percent, quantity, unitPrice } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { carats, HoldingDetail, splitName, unitOf } from './HoldingDetail';
import type { Holding, HoldingKind, InvestmentLot } from '../lib/types';

/**
 * The two kinds are read differently — a fund against what it cost, gold
 * against what it weighs — so they get a tab each rather than being stacked
 * into one scroll where the totals would have to hedge.
 */
const TABS: SegmentOption<HoldingKind>[] = [
  { value: 'fund', label: 'Mutual funds', icon: 'trending-up', accent: 'var(--violet)' },
  { value: 'gold', label: 'Gold', icon: 'coins', accent: 'var(--amber)' },
];

const BLURBS: Record<HoldingKind, string> = {
  fund: 'Units valued at their latest NAV.',
  gold: "Weighed by the gram, valued at today's rate.",
};

const TINTS: Record<HoldingKind, string> = {
  fund: 'var(--violet)',
  gold: 'var(--amber)',
};

export function Investments({
  initialTab = 'fund', onNewHolding, onEditHolding, onAddLot, onEditLot,
}: {
  /** Which kind to open on, for arrivals from elsewhere in the app. */
  initialTab?: HoldingKind;
  onNewHolding: (kind: HoldingKind) => void;
  onEditHolding: (holding: Holding) => void;
  onAddLot: (holding: Holding) => void;
  onEditLot: (holding: Holding, lot: InvestmentLot) => void;
}) {
  const { holdings, refreshPrices, pricesRefreshing } = useStore();
  const [tab, setTab] = useState<HoldingKind>(initialTab);
  const [showClosed, setShowClosed] = useState(false);
  // Held by id rather than by object: the store hands back fresh holdings
  // after every write, and the open page should follow them.
  const [openId, setOpenId] = useState<string | null>(null);

  const viewing = openId ? holdings.find((h) => h.id === openId) ?? null : null;
  // Everything worth something, across both tabs — the one figure that has to
  // stay whole, since it is what the rest of the app calls your investments.
  const portfolio = holdings
    .filter((h) => !h.closed)
    .reduce((sum, h) => sum + h.marketValue, 0);

  const mine = useMemo(() => holdings.filter((h) => h.kind === tab), [holdings, tab]);
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

  // The freshest price anything on this tab is carrying, and whether anything
  // is missing one — an unpriced holding is left out of every total above.
  const priced = open.map((h) => h.priceAsOf).filter((d): d is string => !!d).sort();
  const asOf = priced.length ? priced[priced.length - 1] : undefined;
  const unpriced = open.filter((h) => !h.priceE4).length;

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
          <Button tone="primary" icon="plus" onClick={() => onNewHolding(tab)}>
            {tab === 'gold' ? 'Add gold' : 'Add a fund'}
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
                  <small>{asOf ? `priced ${dayLabel(asOf)}` : 'no prices fetched yet'}</small>
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
                    <div className="holding-total">
                      <span>Rate</span>
                      <strong>{pureRate ? unitPrice(pureRate) : '—'}</strong>
                      <small>a gram of 24K</small>
                    </div>
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
                    <Button tone="primary" icon="plus" onClick={() => onNewHolding(tab)}>
                      {tab === 'gold' ? 'Add gold' : 'Add a fund'}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <Card padded={false} className="row-board">
                <motion.div
                  className="holding-list"
                  variants={listVariants}
                  initial="initial"
                  animate="animate"
                >
                  {open.map((holding) => (
                    <HoldingRow
                      key={holding.id}
                      holding={holding}
                      tint={TINTS[tab]}
                      onOpen={() => setOpenId(holding.id)}
                    />
                  ))}
                </motion.div>
              </Card>
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
                      <Card padded={false} className="row-board">
                        <div className="holding-list">
                          {closed.map((holding) => (
                            <HoldingRow
                              key={holding.id}
                              holding={holding}
                              tint="var(--ink-4)"
                              onOpen={() => setOpenId(holding.id)}
                            />
                          ))}
                        </div>
                      </Card>
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
    </div>
  );
}

/**
 * One line per holding: what it is, how much of it there is, and what that is
 * worth. Cost basis, allocation, entries and ledger links all live one click
 * away on the holding's own page, where there is room to read them properly.
 */
function HoldingRow({
  holding, tint, onOpen,
}: {
  holding: Holding;
  tint: string;
  onOpen: () => void;
}) {
  const unit = unitOf(holding);
  const { title } = splitName(holding);
  const priced = holding.priceE4 !== null;
  const isGold = holding.kind === 'gold';

  const gain = holding.totalReturn;
  const cost = holding.invested - holding.realised;
  const gainPct = cost > 0 ? (gain / cost) * 100 : null;

  // Gold's second line is what it physically is; a fund's is how much of it
  // you own. Either way it is the number you would say out loud.
  const held = isGold
    ? `${quantity(holding.unitsE4, unit)} · ${carats(holding.purityE4)}`
    : quantity(holding.unitsE4, unit);

  return (
    <motion.button
      type="button"
      variants={itemVariants}
      className={`holding-row ${holding.closed ? 'is-closed' : ''}`}
      style={{ ['--tint' as any]: tint }}
      onClick={onOpen}
      whileTap={{ scale: 0.997 }}
    >
      <span className="holding-glyph">
        <Icon name={isGold ? 'coins' : 'trending-up'} size={17} />
      </span>
      <span className="holding-main">
        <span className="holding-name">{title}</span>
        <span className="holding-held">{holding.closed ? `${held} · closed` : held}</span>
      </span>
      <span className="holding-right">
        <strong>{priced ? money(holding.marketValue) : '—'}</strong>
        {!priced ? (
          <span className="is-muted">no price yet</span>
        ) : gainPct !== null ? (
          <span className={gain >= 0 ? 'is-up' : 'is-down'}>
            {percent(gainPct, { sign: true })}
          </span>
        ) : null}
      </span>
      <span className="holding-chevron">
        <Icon name="chevron-right" size={16} />
      </span>
    </motion.button>
  );
}
