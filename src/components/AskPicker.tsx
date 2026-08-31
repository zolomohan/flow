import { Chip } from './ui';
import { askableFor } from '../lib/templates';
import type { TemplateField, TxKind } from '../lib/types';

/**
 * Which of a template's fields are questions rather than answers.
 *
 * A template is worth having because it fills things in, and worth using
 * because the one thing that changes is left for you — the rent is the same
 * every month, the Friday shop never is. Ticked here, a field arrives blank
 * and the transaction will not save until it has been filled in.
 */
export function AskPicker({
  kind, value, onChange, label = 'Ask each time',
}: {
  kind: TxKind;
  value: TemplateField[];
  onChange: (next: TemplateField[]) => void;
  label?: string;
}) {
  const fields = askableFor(kind);
  const asked = fields.filter((field) => value.includes(field.key)).length;

  return (
    <div className="ask-picker">
      <span className="field-label">
        {label}
        <span className="field-hint">
          {asked === 0 ? 'everything is filled in' : `${asked} left for you`}
        </span>
      </span>
      <div className="chip-row">
        {fields.map((field) => {
          const on = value.includes(field.key);
          return (
            <Chip
              key={field.key}
              active={on}
              onClick={() =>
                onChange(
                  on
                    ? value.filter((f) => f !== field.key)
                    : // Kept in the order the form asks them, so the summary
                      // reads the way the sheet is filled in.
                      fields.filter((f) => f.key === field.key || value.includes(f.key))
                        .map((f) => f.key),
                )
              }
            >
              {field.label}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
