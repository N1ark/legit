// CSV and TSV as rows of fields, read as RFC 4180 has them: fields in double quotes may hold the
// delimiter, newlines and `""` (a quote). It's lenient where files aren't: a quote inside an
// unquoted field is kept, text after a closing quote joins the field, an unclosed quote runs to
// the end, rows may have any number of fields. Blank lines aren't rows.

export interface CsvIndex {
  /** The first rows (as many as asked for), each its fields. */
  rows: string[][];
  /** Each of those rows' first and last line in the text (1-based): a quoted field can span lines. */
  lines: [number, number][];
  /** How many rows the text has in all. */
  total: number;
  /** The most fields one of `rows` has. */
  columns: number;
  /** Where rows past `rows` can be read from (see `laterRows`), every so often: [row, offset, line] for each, ascending. */
  marks: number[];
}

/** Rows past those kept, by their place among all rows. */
export interface LaterRows {
  rows: string[][];
  index: number[];
  lines: [number, number][];
}

/** How far apart marks are, in rows or characters, whichever comes first: reading from one to a row is quick. */
const MARK_ROWS = 64;
const MARK_CHARS = 4096;

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

const isBreak = (text: string, i: number) => {
  const c = text.charCodeAt(i);
  return c === LF ? 1 : c === CR && text.charCodeAt(i + 1) === LF ? 2 : 0;
};

/** The rows of `text`: the fields of the first `limit`; the rest are counted, and marked to be read later. */
export function indexDelimited(text: string, delimiter = ',', limit = Infinity): CsvIndex {
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  const out: CsvIndex = { rows: [], lines: [], total: 0, columns: 0, marks: [] };
  let line = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let since = Infinity;
  let at = 0;
  while (i < n) {
    const b = isBreak(text, i);
    if (b) {
      // A blank line.
      i += b;
      line++;
      continue;
    }
    const keep = out.total < limit;
    if (!keep && (since >= MARK_ROWS || i - at >= MARK_CHARS)) {
      out.marks.push(out.total, i, line);
      since = 0;
      at = i;
    }
    const first = line;
    const r = readRow(text, i, d, keep);
    line += r.breaks;
    if (keep) {
      out.rows.push(r.row);
      out.lines.push([first, line]);
      if (r.row.length > out.columns) out.columns = r.row.length;
    }
    out.total++;
    since++;
    i = r.end;
    if (i < n) {
      i += isBreak(text, i);
      line++;
    }
  }
  return out;
}

/** The rows past `index`'s own that hold any of the lines `wanted` (ascending), the first `max` of them. */
export function laterRows(text: string, index: CsvIndex, delimiter: string, wanted: ArrayLike<number>, max: number): LaterRows {
  const out: LaterRows = { rows: [], index: [], lines: [] };
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  const m = index.marks;
  // Where reading goes on from: the start of row `row` (or blank lines before it), at `line`.
  let row = -1;
  let i = 0;
  let line = 0;
  for (let w = 0; w < wanted.length && out.rows.length < max; ) {
    const l = wanted[w];
    let lo = 0;
    let hi = m.length / 3 - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid * 3 + 2] <= l) lo = (k = mid) + 1;
      else hi = mid - 1;
    }
    if (k < 0) {
      w++;
      continue;
    }
    // From the last mark before the line, unless reading on from here is shorter.
    if (m[k * 3] > row) [row, i, line] = [m[k * 3], m[k * 3 + 1], m[k * 3 + 2]];
    for (;;) {
      for (let b; i < n && (b = isBreak(text, i)); i += b) line++;
      if (i >= n) return out;
      const r = readRow(text, i, d, false);
      const last = line + r.breaks;
      const hit = last >= l && line <= l;
      if (hit) {
        out.rows.push(readRow(text, i, d, true).row);
        out.index.push(row);
        out.lines.push([line, last]);
        while (w < wanted.length && wanted[w] <= last) w++;
      } else if (last >= l) {
        // The line is a blank one, before this row.
        while (w < wanted.length && wanted[w] < line) w++;
        break;
      }
      row++;
      i = r.end;
      if (i < n) i += isBreak(text, i);
      line = last + 1;
      if (hit) break;
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
