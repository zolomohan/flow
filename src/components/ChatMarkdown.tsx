import { Fragment, type ReactNode } from 'react';

/**
 * Just enough Markdown for an answer about money: paragraphs, lists, small
 * tables, headings, bold, italics and code. Built as elements rather than
 * HTML, so nothing in an answer — or in a merchant's name quoted in one —
 * can become markup.
 */
export function ChatMarkdown({ text }: { text: string }) {
  return <div className="chat-md">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code.
    if (trimmed.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(<pre key={key()}><code>{body.join('\n')}</code></pre>);
      continue;
    }

    // A table: a header row, a |---| rule, then rows.
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(trimmed);
      const align = cells(lines[i + 1]).map((c) =>
        c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++].trim()));
      // Figures read best lined up on the right, even when nobody asked.
      const numeric = head.map((_, c) =>
        rows.length > 0 && rows.every((r) => !r[c] || /^[-+−]?[₹$]?\s?[\d,.]+%?[A-Za-z]*$/.test(r[c].replace(/\*/g, '').trim())),
      );
      out.push(
        <div className="chat-table-wrap" key={key()}>
          <table className="chat-table">
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c} style={{ textAlign: align[c] ?? (numeric[c] ? 'right' : 'left') }}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {head.map((_, c) => (
                    <td key={c} style={{ textAlign: align[c] ?? (numeric[c] ? 'right' : 'left') }}>
                      {inline(r[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lists, bulleted or numbered.
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i])) {
        let item = lines[i++].replace(marker, '');
        // A wrapped item carries on, indented, on the next line.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(item);
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key()}>
          {items.map((item, n) => <li key={n}>{inline(item)}</li>)}
        </List>,
      );
      continue;
    }

    // Headings are kept small: an answer is not a document.
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      out.push(<h4 key={key()}>{inline(heading[1])}</h4>);
      i++;
      continue;
    }

    // A paragraph runs until a blank line or something else starts.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('|') &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      // A stray line no rule above took, such as a lone '|'.
      para.push(lines[i++].trim());
    }
    out.push(
      <p key={key()}>
        {para.map((l, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Bold, italics and inline code. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={m.index}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
