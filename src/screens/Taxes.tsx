import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Sparkline } from '../components/charts';
import { Button, Card, Chip, Empty, IconButton, Meter, Select, Sheet } from '../components/ui';
import { TransactionRow } from '../components/TransactionRow';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { compactMoney, money, percent, percentDelta, shortDayLabel } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import {
  DEDUCTION_TAGS, GIFT_LIMIT, INCOME_TAGS, PRESUMPTIVE, tagOf,
} from '../lib/tax';
import type { Category, TaxHead, TaxSlice, TaxYear, Transaction } from '../lib/types';

const FY_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

/** A head worth drawing a year of. One lump in April is a fact about timing,
 *  not a shape, and a sparkline through it says something that isn't true. */
const worthCharting = (monthly: number[]) => monthly.filter((v) => v !== 0).length >= 3;

function Figure({
  label, value, hint, tone = 'flat',
}: { label: string; value: string; hint: string; tone?: 'good' | 'bad' | 'warn' | 'flat' }) {
  return (
    <div className={`figure figure-${tone}`}>
      <span className="figure-label">{label}</span>
      <strong className="figure-value">{value}</strong>
      <span className="figure-hint">{hint}</span>
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="section-head">
      <h3>{title}</h3>
      {hint && <span>{hint}</span>}
    </div>
  );
}

/** One head, open or shut. Shut it is a figure; open it is the working —
 *  which categories fed it and who the money actually came from. */
function Head({
  head, share, expanded, onToggle,
}: { head: TaxHead; share: number; expanded: boolean; onToggle: () => void }) {
  const tag = tagOf(head.tag);
  const unfiled = head.tag === '';
  const delta = head.prevTotal > 0 ? percentDelta(head.total, head.prevTotal) : null;

  return (
    <motion.div
      variants={itemVariants}
      className={`tax-head ${expanded ? 'is-open' : ''} ${unfiled ? 'is-unfiled' : ''}`}
    >
      <button className="tax-head-row" onClick={onToggle} type="button">
        <span className="tax-head-glyph" style={{ background: `${tag.color}1f`, color: tag.color }}>
          <Icon name={tag.icon} size={17} />
        </span>
        <span className="tax-head-name">
          <b>{tag.label}</b>
          <em>
            {head.count} {head.count === 1 ? 'transaction' : 'transactions'}
            {head.categories.length > 0 && ` · ${head.categories.length} ${head.categories.length === 1 ? 'category' : 'categories'}`}
          </em>
        </span>
        <span className="tax-head-figures">
          <b>{money(head.total)}</b>
          <em>
            {percent(share * 100)} of the year
            {delta !== null && ` · ${delta > 0 ? '+' : ''}${percent(delta)} on last`}
          </em>
        </span>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} />
      </button>

      <Meter value={share} color={tag.color} />

      {expanded && (
        <motion.div
          className="tax-head-body"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
        >
          <p className="tax-head-note">{tag.note}</p>

          {worthCharting(head.monthly) && (
            <div className="tax-head-chart">
              <Sparkline values={head.monthly} height={64} stroke={tag.color} />
              <div className="tax-head-months">
                {FY_MONTHS.map((m) => (
                  <span key={m}>{m}</span>
                ))}
              </div>
            </div>
          )}

          <div className="tax-head-splits">
            {head.categories.length > 0 && (
              <div>
                <h5>Filed under</h5>
                {head.categories.map((c) => (
                  <Line key={c.id || c.label} slice={c} of={head.total} color={tag.color} />
                ))}
              </div>
            )}
            {head.sources.length > 0 && (
              <div>
                <h5>Came from</h5>
                {head.sources.map((s) => (
                  <Line key={s.label} slice={s} of={head.total} color={tag.color} />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

function Line({ slice, of, color }: { slice: TaxSlice; of: number; color: string }) {
  return (
    <div className="tax-line">
      <span className="tax-line-name">
        {slice.icon && <Icon name={slice.icon} size={14} />}
        {slice.label}
      </span>
      <span className="tax-line-meter">
        <Meter value={of > 0 ? slice.total / of : 0} color={slice.color ?? color} />
      </span>
      <b>{money(slice.total)}</b>
    </div>
  );
}

/** Where the decisions are actually made: every income category, and the head
 *  it answers to. One screen, because filing them one at a time from the
 *  ledger is how a book ends up half-tagged. */
function TagSheet({
  open, onClose, categories, map, onSet,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  map: Record<string, string>;
  onSet: (categoryId: string, tag: string | null) => void;
}) {
  const [side, setSide] = useState<'income' | 'expense'>('income');
  const tags = side === 'income' ? INCOME_TAGS : DEDUCTION_TAGS;
  const rows = categories.filter((c) => c.kind === side);
  const options = tags.map((t) => ({ value: t.id, label: t.label, hint: t.note, icon: t.icon, color: t.color }));
  const done = rows.filter((c) => map[c.id]).length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="How each category is filed"
      subtitle={`${done} of ${rows.length} ${side === 'income' ? 'income' : 'expense'} categories filed`}
      width={640}
    >
      <div className="tax-sheet">
        <div className="tax-sheet-tabs">
          <Chip active={side === 'income'} onClick={() => setSide('income')} count={categories.filter((c) => c.kind === 'income').length}>
            Earnings
          </Chip>
          <Chip active={side === 'expense'} onClick={() => setSide('expense')} count={categories.filter((c) => c.kind === 'expense').length}>
            Deductions
          </Chip>
        </div>

        <p className="tax-sheet-note">
          {side === 'income'
            ? 'Nothing here is guessed from a category’s name. Anything left blank shows as unfiled until you decide.'
            : 'Only tag what your return would ask you to prove. Everything else is simply spending.'}
        </p>

        <div className="tax-sheet-rows">
          {rows.map((c) => (
            <div key={c.id} className="tax-sheet-row">
              <span className="tax-sheet-cat">
                <span className="tax-sheet-dot" style={{ background: c.color }}>
                  <Icon name={c.icon} size={13} />
                </span>
                {c.name}
              </span>
              <Select
                options={options}
                value={map[c.id] ?? null}
                onChange={(next) => onSet(c.id, next)}
                placeholder="Not filed"
                allowClear
                searchable
              />
            </div>
          ))}
          {rows.length === 0 && <Empty title="No categories on this side yet" />}
        </div>
      </div>
    </Sheet>
  );
}

export function Taxes({ onOpenTransaction }: { onOpenTransaction: (tx: Transaction) => void }) {
  const { categories, revision, setTaxTag, toast } = useStore();
  const [fy, setFy] = useState<number | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [data, setData] = useState<TaxYear | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [lens, setLens] = useState(false);

  useEffect(() => {
    api
      .taxYears()
      .then((list) => {
        setYears(list);
        setFy((current) => current ?? list[0] ?? null);
      })
      .catch(() => setYears([]));
  }, [revision]);

  useEffect(() => {
    if (fy === null) return;
    let live = true;
    setLoading(true);
    Promise.all([api.taxYear(fy), api.taxMap()])
      .then(([year, tags]) => {
        if (!live) return;
        setData(year);
        setMap(tags);
      })
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fy, revision]);

  const setTag = useCallback(
    (categoryId: string, tag: string | null) => {
      setMap((m) => {
        const next = { ...m };
        if (tag) next[categoryId] = tag;
        else delete next[categoryId];
        return next;
      });
      void setTaxTag(categoryId, tag);
    },
    [setTaxTag],
  );

  const exportYear = async () => {
    if (!data) return;
    try {
      const csv = await api.taxExport(data.fy);
      await navigator.clipboard.writeText(csv);
      toast(`${data.label} copied as CSV. Paste it wherever it needs to go`);
    } catch {
      toast('Could not put that on the clipboard', 'error');
    }
  };

  const heads = data?.heads ?? [];
  const professional = heads.find((h) => h.tag === 'professional');
  const gifts = heads.find((h) => h.tag === 'gift');

  /** What the old regime is sheltering, and what 115BAC would take back.
   *  Still not a tax figure — it is the input to one. */
  const forfeit = useMemo(
    () =>
      (data?.deductions ?? [])
        .filter((d) => tagOf(d.tag).oldRegimeOnly)
        .reduce((sum, d) => sum + d.total, 0),
    [data],
  );
  const sheltered = useMemo(
    () => (data?.deductions ?? []).reduce((sum, d) => sum + d.total, 0),
    [data],
  );

  const step = (delta: number) => {
    if (fy === null) return;
    const next = fy + delta;
    if (years.includes(next) || next === fy) setFy(next);
  };

  return (
    <div className="screen tax-screen">
      <header className="screen-head">
        <div>
          <h1>Taxes</h1>
          <p>
            Every rupee that came in, sorted the way a return asks, and nothing about
            what it costs. flow will not guess a liability.
          </p>
        </div>
        <div className="tax-nav">
          <IconButton
            icon="chevron-left"
            label="Previous year"
            onClick={() => step(-1)}
            disabled={fy === null || !years.includes(fy - 1)}
          />
          <span className="tax-nav-year">
            <b>{data?.label ?? '—'}</b>
            <em>{data?.assessment ?? ''}</em>
          </span>
          <IconButton
            icon="chevron-right"
            label="Next year"
            onClick={() => step(1)}
            disabled={fy === null || !years.includes(fy + 1)}
          />
        </div>
      </header>

      {!loading && data && data.income === 0 && data.unclassifiedCount === 0 ? (
        <Empty
          screen
          title={`Nothing came in during ${data.label}`}
          body="Income for this year appears here, grouped by head."
        />
      ) : (
        data && (
          <>
            <Card className="tax-summary" padded={false}>
              <div className="tax-summary-lead">
                <div>
                  <span className="figure-label">Earned · {data.label}</span>
                  <strong className="tax-total">{money(data.income)}</strong>
                  <p className="tax-summary-sub">
                    1 April {data.fy} to 31 March {data.fy + 1}
                    {!data.closed && ' · a running total, the year is still open'}
                    {data.prevIncome > 0 &&
                      ` · ${percentDelta(data.income, data.prevIncome)! > 0 ? 'up' : 'down'} ${percent(Math.abs(percentDelta(data.income, data.prevIncome)!))} on FY ${data.fy - 1}-${String((data.fy) % 100).padStart(2, '0')}`}
                  </p>
                </div>
                <div className="tax-summary-actions">
                  <Button icon="tags" onClick={() => setTagging(true)}>
                    File categories
                  </Button>
                  <Button icon="copy" onClick={exportYear}>
                    Copy as CSV
                  </Button>
                </div>
              </div>

              <div className="figure-row">
                <Figure
                  label="Filed"
                  value={money(data.classified)}
                  hint={`${data.heads.filter((h) => h.tag).length} heads`}
                  tone="good"
                />
                <Figure
                  label="Not yet filed"
                  value={money(data.unclassified)}
                  hint={
                    data.unclassified === 0
                      ? 'every rupee has a head'
                      : `${data.unclassifiedCount} transactions · ${data.untaggedCategories} categories to decide`
                  }
                  tone={data.unclassified === 0 ? 'good' : 'warn'}
                />
                <Figure
                  label="Sheltered"
                  value={money(sheltered)}
                  hint={
                    sheltered === 0
                      ? 'nothing tagged on the deduction side'
                      : `${money(forfeit)} of it is old-regime only`
                  }
                />
              </div>
            </Card>

            {data.unclassified > 0 && (
              <Card className="tax-alert">
                <div className="tax-alert-head">
                  <Icon name="circle-dashed" size={18} />
                  <div>
                    <b>{money(data.unclassified)} has no head yet</b>
                    <span>
                      Every figure on this page is incomplete until this is empty.
                      Tagging a category files everything under it at once.
                    </span>
                  </div>
                  <Button tone="primary" icon="tags" onClick={() => setTagging(true)}>
                    File them
                  </Button>
                </div>
              </Card>
            )}

            <SectionHead
              title="What came in"
              hint={`${heads.length} ${heads.length === 1 ? 'head' : 'heads'} · click one for the working`}
            />
            <Card padded={false}>
              <motion.div variants={listVariants} initial="initial" animate="animate">
                {heads.map((head) => (
                  <Head
                    key={head.tag || 'unfiled'}
                    head={head}
                    share={data.income > 0 ? head.total / data.income : 0}
                    expanded={open === (head.tag || 'unfiled')}
                    onToggle={() =>
                      setOpen(open === (head.tag || 'unfiled') ? null : head.tag || 'unfiled')
                    }
                  />
                ))}
              </motion.div>
            </Card>

            {professional && professional.total > 0 && (
              <Card className="tax-limit">
                <SectionHead
                  title="Presumptive ceiling"
                  hint="44ADA · gross receipts, not profit"
                />
                <div className="tax-limit-body">
                  <strong>{money(professional.total)}</strong>
                  <Meter
                    value={professional.total / PRESUMPTIVE['44ADA'].base}
                    color={tagOf('professional').color}
                  />
                  <p>
                    {compactMoney(PRESUMPTIVE['44ADA'].base - professional.total)} of headroom
                    under the ₹50 lakh limit, or {compactMoney(PRESUMPTIVE['44ADA'].extended - professional.total)}{' '}
                    if cash receipts stayed within 5% of the total. Past either,
                    presumptive filing is no longer available.
                  </p>
                </div>
              </Card>
            )}

            {gifts && gifts.total > 0 && (
              <Card className="tax-limit">
                <SectionHead title="Gifts received" hint="s.56(2)(x)" />
                <div className="tax-limit-body">
                  <strong>{money(gifts.total)}</strong>
                  <Meter
                    value={gifts.total / GIFT_LIMIT}
                    color={gifts.total > GIFT_LIMIT ? 'var(--red)' : tagOf('gift').color}
                  />
                  <p>
                    {gifts.total > GIFT_LIMIT
                      ? 'Past ₹50,000 for the year, so the whole amount is taxable, not just the excess. Gifts from close relatives, or received on your marriage, are exempt and belong elsewhere.'
                      : `${money(GIFT_LIMIT - gifts.total)} before the year’s aggregate crosses ₹50,000, at which point the whole of it becomes taxable rather than the excess.`}
                  </p>
                </div>
              </Card>
            )}

            {data.interest.length > 0 && (
              <>
                <SectionHead
                  title="Interest, by account"
                  hint="matches how AIS reports it"
                />
                <Card padded={false}>
                  {data.interest.map((row) => (
                    <div key={row.id} className="tax-line tax-line-pad">
                      <span className="tax-line-name">
                        {row.icon && <Icon name={row.icon} size={14} />}
                        {row.label}
                      </span>
                      <span className="tax-line-meter">
                        <Meter
                          value={row.total / Math.max(...data.interest.map((i) => i.total))}
                          color={row.color ?? tagOf('interest').color}
                        />
                      </span>
                      <b>{money(row.total)}</b>
                    </div>
                  ))}
                </Card>
              </>
            )}

            <SectionHead
              title="Advance tax"
              hint="income received by each due date"
            />
            <Card padded={false}>
              <div className="tax-quarters">
                {data.quarters.map((q) => (
                  <div key={q.dueOn} className={`tax-quarter ${q.past ? 'is-past' : ''}`}>
                    <span className="tax-quarter-share">{q.share}%</span>
                    <b>{money(q.income)}</b>
                    <em>
                      {q.label} · {shortDayLabel(q.dueOn)}
                      {q.past ? '' : ' · ahead'}
                    </em>
                  </div>
                ))}
              </div>
            </Card>

            {data.deductions.length > 0 && (
              <>
                <SectionHead
                  title="What you are sheltering"
                  hint={
                    lens
                      ? 'The new regime takes back everything marked'
                      : `${money(forfeit)} of it exists only under the old regime`
                  }
                />
                <Card padded={false}>
                  <div className="tax-lens">
                    <Chip active={lens} onClick={() => setLens(!lens)}>
                      Show what the new regime takes back
                    </Chip>
                  </div>
                  {data.deductions.map((d) => {
                    const tag = tagOf(d.tag);
                    const lost = lens && tag.oldRegimeOnly;
                    return (
                      <div key={d.tag} className={`tax-line tax-line-pad ${lost ? 'is-lost' : ''}`}>
                        <span className="tax-line-name">
                          <Icon name={tag.icon} size={14} />
                          {tag.label}
                          {lost && <em className="tax-lost-flag">forfeited</em>}
                        </span>
                        <span className="tax-line-meter">
                          <Meter value={sheltered > 0 ? d.total / sheltered : 0} color={tag.color} />
                        </span>
                        <b>{money(d.total)}</b>
                      </div>
                    );
                  })}
                </Card>
              </>
            )}

            {data.unfiled.length > 0 && (
              <>
                <SectionHead
                  title="Waiting on a decision"
                  hint={`${data.unclassifiedCount} transactions${data.unfiled.length < data.unclassifiedCount ? ` · newest ${data.unfiled.length}` : ''}`}
                />
                <Card padded={false}>
                  {data.unfiled.map((tx) => (
                    <TransactionRow key={tx.id} tx={tx} onClick={() => onOpenTransaction(tx)} showDate={shortDayLabel(tx.occurredAt)} />
                  ))}
                </Card>
              </>
            )}

            <p className="tax-footnote">
              Your ledger, grouped the way a return asks its questions. This is not a
              tax computation, and it is not advice.
            </p>
          </>
        )
      )}

      <TagSheet
        open={tagging}
        onClose={() => setTagging(false)}
        categories={categories}
        map={map}
        onSet={setTag}
      />
    </div>
  );
}
