import { useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { TemplateSheet } from '../components/TemplateSheet';
import { Button, Card, Confirm, Empty } from '../components/ui';
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
  // The template being asked about, held by id: the row it belongs to is
  // still there behind the dialog, and the list is rebuilt on every save.
  const [confirming, setConfirming] = useState<string | null>(null);

  // The sheet edits the copy it was opened with, so it follows the book
  // rather than going stale behind a save.
  const open = editing ? (templates.find((t) => t.id === editing.id) ?? null) : null;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Templates</h1>
          <p>
            The transactions you write again and again: the rent, the Friday shop,
            the standing transfer. Everything but the date, kept under a name.
          </p>
        </div>
      </header>

      {templates.length === 0 ? (
        <Empty
          screen
          art="templates"
          tone="violet"
          title="No templates yet"
          body="Save a transaction you write often, then reuse it in one click."
          action={
            <Button tone="primary" icon="plus" onClick={onAddTransaction}>
              New transaction
            </Button>
          }
        />
      ) : (
        <Card padded={false}>
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
                      {template.labels.filter((l) => !l.silent).map((label) => (
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
                      tone="ghost"
                      icon="trash-2"
                      onClick={() => setConfirming(template.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        </Card>
      )}

      <TemplateSheet open={!!open} onClose={() => setEditing(null)} editing={open} />

      <Confirm
        open={!!confirming}
        title="Delete this template?"
        onConfirm={async () => {
          const id = confirming;
          setConfirming(null);
          if (!id) return;
          if (editing?.id === id) setEditing(null);
          await deleteTemplate(id).catch(() => {});
        }}
        onCancel={() => setConfirming(null)}
      >
        {templates.find((t) => t.id === confirming)?.name
          ? `${templates.find((t) => t.id === confirming)!.name} goes. Everything written from it stays in your ledger.`
          : 'Everything written from it stays in your ledger.'}
      </Confirm>
    </div>
  );
}
