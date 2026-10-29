// CSV and TSV as rows of fields, read as RFC 4180 has them: fields in double quotes may hold the
// delimiter, newlines and `""` (a quote). It's lenient where files aren't: a quote inside an
// unquoted field is kept, text after a closing quote joins the field, an unclosed quote runs to
// the end, rows may have any number of fields. Blank lines aren't rows.

export interface Table {
  /** The rows kept, each its fields: the first ones, then any others asked for. */
  rows: string[][];
  /** Each kept row's place among all rows (0 for the first). */
  index: number[];
  /** Each kept row's first and last line in the text (1-based): a quoted field can span lines. */
  lines: [number, number][];
  /** How many rows the text has in all. */
  total: number;
  /** The most fields a kept row has. */
  columns: number;
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

/** Where a row read from `i` ends (at its line break or the end), how many line breaks its quoted fields hold, and its fields if kept. */
function readRow(text: string, i: number, d: number, keep: boolean): { end: number; breaks: number; row: string[] } {
  const n = text.length;
  const row: string[] = [];
  let breaks = 0;
  for (;;) {
    let field = '';
    if (text.charCodeAt(i) === QUOTE) {
      let from = i + 1;
      for (let k = from; ; k++) {
        if (k >= n) {
          if (keep) field += text.slice(from, n);
          i = n;
          break;
        }
        const ch = text.charCodeAt(k);
        if (ch === LF) breaks++;
        else if (ch === QUOTE) {
          if (keep) field += text.slice(from, k);
          if (text.charCodeAt(k + 1) !== QUOTE) {
            i = k + 1;
            break;
          }
          if (keep) field += '"';
          from = ++k + 1;
        }
      }
    }
    // Unquoted, or what follows a closing quote: up to the delimiter or the end of the line.
    const from = i;
    for (; i < n; i++) {
      const ch = text.charCodeAt(i);
      if (ch === d || ch === LF || (ch === CR && text.charCodeAt(i + 1) === LF)) break;
    }
    if (keep) row.push(i > from ? field + text.slice(from, i) : field);
    if (i < n && text.charCodeAt(i) === d) i++;
    else return { end: i, breaks, row };
  }
}

/** The rows of `text`, keeping the fields of the first `limit`, and of any later row whose lines
 *  `also` wants (up to `limit` of them); the rest are just counted. */
export function parseDelimited(
  text: string,
  delimiter = ',',
  limit = Infinity,
  also?: (first: number, last: number) => boolean,
): Table {
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  const out: Table = { rows: [], index: [], lines: [], total: 0, columns: 0 };
  let line = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === LF || (c === CR && text.charCodeAt(i + 1) === LF)) {
      // A blank line.
      i += c === LF ? 1 : 2;
      line++;
      continue;
    }
    const first = line;
    let r = readRow(text, i, d, out.total < limit);
    line += r.breaks;
    if (out.total >= limit && also && out.rows.length < 2 * limit && also(first, line)) r = readRow(text, i, d, true);
    if (r.row.length) {
      out.rows.push(r.row);
      out.index.push(out.total);
      out.lines.push([first, line]);
      if (r.row.length > out.columns) out.columns = r.row.length;
    }
    out.total++;
    i = r.end;
    if (i < n) {
      i += text.charCodeAt(i) === LF ? 1 : 2;
      line++;
    }
  }
  return out;
}

const NUMBER = /^[-+]?(?:\d[\d,_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?$/i;

/** For each column, whether every cell in it below the header that isn't empty is a number (so it's aligned right). */
export function numericColumns(rows: string[][], columns: number): boolean[] {
  const out: boolean[] = [];
  for (let c = 0; c < columns; c++) {
    let any = false;
    let all = true;
    for (let r = 1; r < rows.length && all; r++) {
      const v = rows[r][c]?.trim();
      if (!v) continue;
      any = true;
      all = NUMBER.test(v);
    }
    out.push(any && all);
  }
  return out;
}
