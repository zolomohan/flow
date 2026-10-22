import { useState } from 'react';
import { Confirm } from './ui';
import { RecordPicker } from './RecordPicker';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { Plan } from '../lib/types';

/**
 * Saying which payments belong to a plan.
 *
 * It is the ledger itself, opened on the plan's payee and ticking rather than
 * choosing — so the day headers, the search, the filters and the ranges are
 * the ones already learned. A payment another plan is holding can still be
 * picked, because moving one is a real thing to want; it just asks first.
 */
export function PlanLinkSheet({
  open, onClose, plan,
}: {
  open: boolean;
  onClose: () => void;
  plan: Plan | null;
}) {
  const { linkPlanPostings } = useStore();
  // Picked payments another plan already holds, held back while it asks.
  const [moving, setMoving] = useState<{ ids: string[]; from: string[] } | null>(null);

  const link = async (ids: string[]) => {
    if (!plan || !ids.length) return;
    await linkPlanPostings(plan.id, ids);
    setMoving(null);
    onClose();
  };

  const picked = async (ids: string[]) => {
    if (!plan || !ids.length) return;
    // Nothing is taken off another plan without being asked about: a payment
    // backs one plan, so linking it here is a move rather than a copy.
    let held: Record<string, string> = {};
    try {
      held = await api.plansOfPostings(ids);
    } catch {
      /* the check is a courtesy; failing it should not block the link */
    }
    const from = [...new Set(Object.values(held).filter((name) => name !== plan.name))];
    if (from.length) return setMoving({ ids, from });
    await link(ids);
  };

  return (
    <>
      <RecordPicker
        open={open}
        onClose={onClose}
        onPickMany={picked}
        pickLabel="Link"
        // Opened on the payee, which is what somebody is nearly always after
        // — and clearable, because the whole point is that a payment filed
        // under something else can still be found.
        search={plan?.merchant || plan?.name}
        title={`Link payments to ${plan?.name ?? 'this plan'}`}
        subtitle="Tick the payments that belong to this plan"
      />

      <Confirm
        stacked
        open={!!moving}
        onCancel={() => setMoving(null)}
        onConfirm={() => moving && link(moving.ids)}
        title="Move these onto this plan?"
        confirmLabel="Move them"
        icon="link"
        tone="primary"
      >
        {moving?.from.length === 1
          ? `Some of these are on ${moving.from[0]}. A payment belongs to one plan, so linking them here takes them off it.`
          : `Some of these are on other plans (${moving?.from.join(', ')}). A payment belongs to one plan, so linking them here takes them off those.`}
      </Confirm>
    </>
  );
}
