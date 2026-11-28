/**
 * Everything held, on one page: the phone's Investments tab.
 *
 * The three sleeves each have a screen of their own, priced their own way.
 * This is the page above them — what it is all worth now, how that has moved,
 * and one card per sleeve summing it up, with its own line drawn small on the
 * right, each of which opens that sleeve's screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { PriceChart, Sparkline } from '../components/charts';
import { Icon } from '../components/Icon';
import { Button, Empty, Segmented, type SegmentOption } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { money, percent } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { isDeposit } from '../lib/types';
import type { HoldingKind, InvestmentTab, ValuePoint } from '../lib/types';

type Range = '30' | '90' | '366' | 'all';
const RANGES: SegmentOption<Range>[] = [
  { value: '30', label: '1M' },
  { value: '90', label: '3M' },
  { value: '366', label: '1Y' },
  { value: 'all', label: 'All' },
];

/** The cards' own lines are a year: what most people mean by "lately". */
const CARD_DAYS = 366;

const SLEEVES: { tab: InvestmentTab; name: string; icon: string; color: string }[] = [
  { tab: 'fund', name: 'Mutual funds', icon: 'trending-up', color: 'var(--violet)' },
  { tab: 'gold', name: 'Gold', icon: 'coins', color: 'var(--amber)' },
  { tab: 'deposit', name: 'Deposits', icon: 'landmark', color: 'var(--blue)' },
];

const sleeveOf = (kind: HoldingKind): InvestmentTab => (isDeposit(kind) ? 'deposit' : kind);

export function Portfolio({
  onOpenSleeve, onNewHolding,
}: {
  onOpenSleeve: (tab: InvestmentTab) => void;
  onNewHolding: () => void;
}) {
  const { holdings, revision } = useStore();
  const [range, setRange] = useState<Range>('366');
  const [line, setLine] = useState<ValuePoint[] | null>(null);
  const [lines, setLines] = useState<Record<string, ValuePoint[]> | null>(null);

  useEffect(() => {
    let live = true;
    setLine(null);
    api
      .portfolioValueSeries(range === 'all' ? null : Number(range))
      .then((points) => live && setLine(points))
      .catch(() => live && setLine([]));
    return () => {
      live = false;
    };
  }, [range, revision]);

  useEffect(() => {
    let live = true;
    Promise.all(
      SLEEVES.map((s) =>
        api.sleeveValueSeries(s.tab, CARD_DAYS).then((points) => [s.tab, points] as const).catch(() => [s.tab, []] as const),
      ),
    ).then((all) => live && setLines(Object.fromEntries(all)));
    return () => {
      live = false;
    };
  }, [revision]);

  const open = useMemo(
    () => holdings.filter((h) => !h.closed).sort((a, b) => b.marketValue - a.marketValue),
    [holdings],
  );
  const worth = open.reduce((sum, h) => sum + h.marketValue, 0);
  const invested = open.reduce((sum, h) => sum + h.invested - h.realised, 0);
  const gain = open.reduce((sum, h) => sum + h.totalReturn, 0);
  const gainPct = invested > 0 ? (gain / invested) * 100 : null;

  // How the line moved over the window on show, which is what the range asks.
  const moved = line && line.length > 1 ? line[line.length - 1].value - line[0].value : null;
  const movedPct = moved !== null && line![0].value > 0 ? (moved / line![0].value) * 100 : null;

  const groups = SLEEVES.flatMap((sleeve) => {
    const mine = open.filter((h) => sleeveOf(h.kind) === sleeve.tab);
    if (!mine.length) return [];
    const base = mine.reduce((s, h) => s + h.invested - h.realised, 0);
    const ret = mine.reduce((s, h) => s + h.totalReturn, 0);
    return [{
      ...sleeve,
      count: mine.length,
      worth: mine.reduce((s, h) => s + h.marketValue, 0),
      ret,
      pct: base > 0 ? (ret / base) * 100 : null,
    }];
  });

  return (
    <div className="screen portfolio">
      <header className="screen-head">
        <h1>Investments</h1>
        <div className="screen-actions">
          <Button tone="quiet" icon="plus" onClick={onNewHolding}>
            Add holding
          </Button>
        </div>
      </header>

      {open.length === 0 ? (
        <Empty
          screen
          art="growth"
          title="Nothing held yet"
          body="Add a fund, some gold or a deposit and it shows up here, with how it has moved."
        />
      ) : (
        <>
          <motion.section
            className="portfolio-hero"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
          >
            <span className="portfolio-label">Total value</span>
            <div className="portfolio-value">
              <span className="portfolio-amount">{money(worth)}</span>
              {gainPct !== null && (
                <span className={`portfolio-trend ${gain >= 0 ? 'is-up' : 'is-down'}`}>
                  <Icon name={gain >= 0 ? 'trending-up' : 'trending-down'} size={13} />
                  {percent(gainPct, { sign: true })}
                </span>
              )}
            </div>
            <span className="portfolio-sub">
              {money(gain, { sign: true })} on {money(invested)} put in
            </span>
            <div className="portfolio-chart">
              <PriceChart
                points={line ?? []}
                loading={line === null}
                height={180}
                stroke="var(--green)"
                kind="money"
              />
            </div>
            <div className="portfolio-range">
              <Segmented options={RANGES} value={range} onChange={setRange} size="sm" />
              {moved !== null && (
                <span className={moved >= 0 ? 'is-up' : 'is-down'}>
                  {money(Math.round(moved / 100) * 100, { sign: true })}
                  {movedPct !== null && ` · ${percent(movedPct, { sign: true })}`}
                </span>
              )}
            </div>
          </motion.section>

          <motion.div className="portfolio-list" variants={listVariants} initial="hidden" animate="show">
            {groups.map((group) => {
              const values = (lines?.[group.tab] ?? []).map((p) => p.value);
              const tone = values.length > 1
                ? values[values.length - 1] >= values[0] ? 'var(--green)' : 'var(--red)'
                : group.color;
              return (
                <motion.button
                  key={group.tab}
                  type="button"
                  variants={itemVariants}
                  className="portfolio-card"
                  onClick={() => onOpenSleeve(group.tab)}
                >
                  <span className="portfolio-card-text">
                    <span className="portfolio-card-name">
                      <span className="portfolio-group-icon" style={{ color: group.color }}>
                        <Icon name={group.icon} size={14} />
                      </span>
                      {group.name}
                    </span>
                    <span className="portfolio-card-detail">
                      {group.count} {group.count === 1 ? 'holding' : 'holdings'}
                      {worth > 0 && ` · ${percent((group.worth / worth) * 100)} of it`}
                    </span>
                    <span className="portfolio-card-figures">
                      <strong>{money(group.worth)}</strong>
                      {group.pct !== null && (
                        <span className={group.ret >= 0 ? 'is-up' : 'is-down'}>{percent(group.pct, { sign: true })}</span>
                      )}
                    </span>
                  </span>
                  <span className="portfolio-card-chart">
                    {lines !== null && values.length < 2 ? (
                      // No prices behind it yet: a level rule, not a gap.
                      <span className="portfolio-card-flat" />
                    ) : (
                      <Sparkline values={values} height={44} stroke={tone} loading={lines === null} />
                    )}
                  </span>
                </motion.button>
              );
            })}
          </motion.div>
        </>
      )}
    </div>
  );
}
