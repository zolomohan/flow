import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { TemplateSheet } from '../components/TemplateSheet';
import { Button, Card, Empty } from '../components/ui';
import { useStore } from '../lib/store';
import { dayLabel } from '../lib/format';
import { describeTemplate } from '../lib/templates';
import { itemVariants, listVariants } from '../lib/motion';
import type { TxTemplate } from '../lib/types';

/**
 * The transactions worth writing more than once, kept by name.
 *
 * A template holds the shape of a posting and not a posting — no date,
 * because the date is the one thing that is never the same twice. What is
 * inside one is changed by using it: fill the sheet in, correct what needs
 * correcting, and save it back under the same name.
 */
export function Templates({
  onUseTemplate,
  onAddTransaction,
}: {
  /** Opens a new transaction filled in from this template. */
  onUseTemplate: (template: TxTemplate) => void;
  onAddTransaction: () => void;
}) {
  const { templates, deleteTemplate } = useStore();
  const [editing, setEditing] = useState<TxTemplate | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // A delete armed and then abandoned disarms itself.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  // The sheet edits the copy it was opened with, so it follows the book
  // rather than going stale behind a save.
  const open = editing ? (templates.find((t) => t.id === editing.id) ?? null) : null;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Templates</h1>
          <p>
            The transactions you write again and again — the rent, the Friday shop,
            the standing transfer. Everything but the date, kept under a name.
          </p>
        </div>
      </header>

      <Card padded={false}>
        {templates.length === 0 ? (
          <div className="card-pad">
            <Empty
              icon="shapes"
              title="No templates yet"
              body="Fill a transaction in the way you keep filling it in, then open Templates at the foot of the sheet and save it. The next one like it is a single click."
              action={
                <Button tone="primary" icon="plus" onClick={onAddTransaction}>
                  New transaction
                </Button>
              }
            />
          </div>
        ) : (
          <motion.div
            className="tpl-list"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {templates.map((template) => {
              const tint = template.categoryColor ?? 'var(--ink-3)';
              const glyph =
                template.categoryIcon ??
                (template.kind === 'transfer'
                  ? 'arrow-left-right'
                  : template.kind === 'income'
                    ? 'arrow-down-left'
                    : 'circle-dashed');
              return (
                <motion.div key={template.id} className="tpl-row" variants={itemVariants}>
                  <span className="tpl-glyph" style={{ ['--tint' as any]: tint }}>
                    <Icon name={glyph} size={16} strokeWidth={2.1} />
                  </span>

                  <button
                    type="button"
                    className="tpl-name"
                    onClick={() => onUseTemplate(template)}
                    title="Write a transaction from this"
                  >
                    {template.name}
                    <em>
                      {describeTemplate(template)}
                      {template.labels.map((label) => (
                        <span
                          key={label.id}
                          className="tx-label"
                          style={{ ['--tint' as any]: label.color }}
                        >
                          {label.name}
                        </span>
                      ))}
                    </em>
                  </button>

                  <span className="tpl-used">
                    {template.usedCount === 0
                      ? 'Not used yet'
                      : `Used ${template.usedCount} ${
                          template.usedCount === 1 ? 'time' : 'times'
                        }`}
                    {template.lastUsedAt && <em>{dayLabel(template.lastUsedAt)}</em>}
                  </span>

                  <div className="tpl-actions">
                    <Button
                      size="sm"
                      tone="ghost"
                      icon="plus"
                      onClick={() => onUseTemplate(template)}
                    >
                      Use
                    </Button>
                    <Button
                      size="sm"
                      tone="ghost"
                      icon="pencil"
                      onClick={() => setEditing(template)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      tone={confirming === template.id ? 'danger' : 'ghost'}
                      icon="trash-2"
                      onClick={async () => {
                        if (confirming !== template.id) return setConfirming(template.id);
                        setConfirming(null);
                        if (editing?.id === template.id) setEditing(null);
                        await deleteTemplate(template.id).catch(() => {});
                      }}
                    >
                      {confirming === template.id ? 'Sure?' : 'Delete'}
                    </Button>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </Card>

      <TemplateSheet open={!!open} onClose={() => setEditing(null)} editing={open} />
    </div>
  );
}
