import { useState } from 'react';
import { Icon } from './Icon';
import { Button } from './ui';
import { ChatMarkdown } from './ChatMarkdown';
import type { Part } from '../lib/chat';
import type { AiChangeCard, AiPendingChange } from '../lib/types';
import { money, shortDayLabel } from '../lib/format';

/* The pieces of a chat that both Ask and the ledger's quick chat draw:
   an answer as it streams, the lookups behind it, and a change's card. */

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function Answer({ parts, live = false }: { parts: Part[]; live?: boolean }) {
  const lastText = parts.length > 0 && parts[parts.length - 1].kind === 'text';
  return (
    <div className="ask-a">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <ChatMarkdown key={i} text={p.text} />
        ) : p.kind === 'lookup' ? (
          <LookupLine key={i} part={p} />
        ) : (
          <div key={i} className={`ask-change is-${p.status}`}>
            <Icon name={p.status === 'applied' ? 'check' : p.status === 'declined' ? 'x' : 'alert-circle'} size={14} />
            <span>
              <strong>
                {p.status === 'applied' ? 'Applied' : p.status === 'declined' ? 'Declined' : 'Couldn’t apply'}
              </strong>{' '}
              {p.title}
              {p.error && <em> · {p.error}</em>}
            </span>
          </div>
        ),
      )}
      {live && !lastText && (
        <div className="ask-thinking">
          <span /><span /><span />
        </div>
      )}
    </div>
  );
}

function LookupLine({ part }: { part: Part & { kind: 'lookup' } }) {
  const [open, setOpen] = useState(false);
  const sql = (part.input as { sql?: string } | undefined)?.sql;
  const month = (part.input as { month?: string } | undefined)?.month;
  const path = (part.input as { path?: string } | undefined)?.path;
  const label =
    part.tool === 'read_statement' || part.tool === 'read_file'
      ? `Read ${path ? fileName(path) : part.tool === 'read_file' ? 'the file' : 'the statement'}`
      : part.tool === 'query_book'
      ? 'Looked in the book'
      : part.tool === 'list_accounts'
        ? 'Read account balances'
        : part.tool === 'book_summary'
          ? `Read the overview${month ? ` for ${month}` : ''}`
          : part.tool;
  const detail = !part.done
    ? part.tool === 'read_statement'
      ? part.found
        ? `${part.found} found so far…`
        : 'reading…'
      : 'looking…'
    : part.error
      ? 'failed'
      : part.rows !== undefined
        ? `${part.rows} ${part.rows === 1 ? 'row' : 'rows'}`
        : null;
  return (
    <div className={`ask-lookup ${part.error ? 'is-error' : ''}`}>
      <button className="ask-lookup-line" onClick={() => setOpen((o) => !o)} disabled={!sql && !part.error}>
        <Icon name={part.done ? 'search' : 'refresh-cw'} size={13} className={part.done ? '' : 'spin'} />
        <span>{label}</span>
        {detail && <span className="ask-lookup-detail">{detail}</span>}
        {(sql || part.error) && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
      </button>
      {open && (
        <div className="ask-lookup-body">
          {sql && <pre>{sql.trim()}</pre>}
          {part.error && <p>{part.error}</p>}
        </div>
      )}
    </div>
  );
}

const ACTIONS: Record<AiChangeCard['action'], { label: string; icon: string }> = {
  add: { label: 'New transaction', icon: 'plus' },
  edit: { label: 'Edit', icon: 'pencil' },
  change: { label: 'Change in bulk', icon: 'sliders-horizontal' },
  delete: { label: 'Delete', icon: 'trash-2' },
  category: { label: 'New category', icon: 'tags' },
  label: { label: 'Labels', icon: 'tag' },
  import: { label: 'Import', icon: 'file-up' },
};

/** How many rows a card shows before it offers the rest. */
const ROWS_FIRST = 5;

/**
 * One change Claude wants to make, on a card of its own: what kind of change
 * it is, what it sets (and what that was), and the transactions it touches,
 * lined up like the ledger. Its own Apply and Decline sit at the bottom.
 */
export function PendingCard({
  change, decision, index, count, onDecide,
}: {
  change: AiPendingChange;
  decision?: boolean;
  index: number;
  count: number;
  onDecide: (id: string, applied: boolean) => void;
}) {
  const [all, setAll] = useState(false);
  const card = change.card;
  const action = card ? ACTIONS[card.action] : { label: 'Change', icon: 'pencil' };
  const destructive = change.tool === 'delete_transactions' || card?.action === 'delete';
  const decided = decision !== undefined;
  const rows = card ? (all ? card.rows : card.rows.slice(0, ROWS_FIRST)) : [];
  const hidden = card ? card.rows.length - rows.length + card.more : 0;
  const lines = change.lines.filter(Boolean);

  return (
    <div className={`ask-pending-card is-${card?.action ?? 'edit'} ${decided ? 'is-decided' : ''}`}>
      <div className="apc-head">
        <span className="apc-badge">
          <Icon name={action.icon} size={15} />
        </span>
        <div className="apc-heading">
          <span className="apc-kind">
            {action.label}
            {count > 1 && <span className="apc-step"> · {index + 1} of {count}</span>}
          </span>
          <strong>{change.title}</strong>
        </div>
        {decided && (
          <span className={`apc-said ${decision ? 'is-yes' : 'is-no'}`}>
            <Icon name={decision ? 'check' : 'x'} size={13} strokeWidth={2.6} />
            {decision ? (destructive ? 'Will delete' : 'Will apply') : 'Will decline'}
          </span>
        )}
      </div>

      {card ? (
        <>
          {card.fields.length > 0 && (
            <dl className="apc-fields">
              {card.fields.map((f, i) => (
                <div key={i} className="apc-field">
                  <dt>{f.name}</dt>
                  <dd>
                    {f.from !== null && f.from !== f.to && (
                      <>
                        <s>{f.from}</s>
                        <Icon name="arrow-right" size={13} />
                      </>
                    )}
                    <span>{f.to}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {card.notes.length > 0 && (
            <ul className="apc-notes">
              {card.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          {rows.length > 0 && (
            <div className="apc-rows">
              {card.rows.length + card.more > 1 && (
                <div className="apc-rows-head">
                  {destructive ? 'Goes' : card.action === 'add' ? 'Adds' : 'Touches'}{' '}
                  {(card.rows.length + card.more).toLocaleString('en-IN')} transactions
                </div>
              )}
              <table>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="apc-date">{r.date ? shortDayLabel(r.date) : ''}</td>
                      <td className="apc-what">
                        <span>{r.merchant || 'No description'}</span>
                        {r.was !== undefined && <s className="apc-was">{r.was || 'No description'}</s>}
                        {r.note !== undefined && <em className="apc-row-note">{r.note}</em>}
                        <small>{r.filed} · {r.account}</small>
                      </td>
                      <td className={`apc-amount is-${r.kind}`}>
                        {money(r.kind === 'expense' ? -r.amount : r.amount, { sign: r.kind === 'income' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hidden > 0 && card.rows.length > rows.length && (
                <button className="apc-more" onClick={() => setAll(true)}>
                  Show {card.rows.length - rows.length} more
                  {card.more > 0 && ` (${card.more.toLocaleString('en-IN')} beyond those aren't listed)`}
                </button>
              )}
              {hidden > 0 && card.rows.length === rows.length && (
                <p className="apc-more is-static">and {card.more.toLocaleString('en-IN')} more</p>
              )}
            </div>
          )}
        </>
      ) : (
        lines.length > 0 && (
          <ul className="apc-notes">
            {lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )
      )}

      {!decided && (
        <div className="apc-actions">
          <Button tone="ghost" onClick={() => onDecide(change.id, false)}>Decline</Button>
          <Button
            tone={destructive ? 'danger' : 'primary'}
            icon={destructive ? 'trash-2' : 'check'}
            onClick={() => onDecide(change.id, true)}
          >
            {destructive ? 'Delete' : 'Apply'}
          </Button>
        </div>
      )}
    </div>
  );
}

