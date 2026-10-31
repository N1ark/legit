<script module lang="ts">
  import type { RenderedText } from './lib/app.svelte.ts';
  import { Lru } from './lib/cache.ts';

  /** The code font's character width, as the last view measured it: the next one starts with it. */
  let knownCharWidth = 0;
  /** What each rendered file showed last, by path: a view opening on a newer version shows it until that's in. */
  const lastShown = new Lru<string, RenderedText & { changed?: ReadonlySet<number>; old?: string }>(10, 12_000_000);
  /** Rendered files' heights as last measured, by path, version and width, and by path and width alone (any version's,
   *  about as tall), so a view opening on one starts at (or near) its height. */
  const knownHeights = new Map<string, number>();
  /** The diff's width, as the last view measured it: a new one looks those heights up at it until it's measured. */
  let knownPaneWidth = 0;
</script>

<script lang="ts">
  // Virtualized diff. Rows have a fixed height and never wrap, so every file's height is
  // known from the summary alone: the full layout (and scrollbar) exists before any content
  // loads, nothing is ever measured, and nothing jumps. (When long lines wrap, a file with lines
  // wider than the wrap takes its height from its contents once they're in, keeping the view
  // where it was; the code breaks anywhere, so a line's rows follow from its length. A file shown
  // rendered takes its height from its layout, measured, the same way.) Only files near the viewport are
  // mounted, and within them only the rows near the viewport. Contents load as files come
  // into view; highlighting runs in a worker and fills in afterwards.
  import {
    type MaybeEntry,
    IconButton,
    Popover,
    ResizeEdge,
    Tag,
    Twisty,
    fixedRange,
    menu,
    offsets,
    persisted,
    rowAt,
    Switch,
    toast,
    tooltip,
    variableRange,
  } from 'purr';
  import { ArrowLineDownRegular, ArrowLineUpRegular, ArrowsOutLineVerticalRegular, ChatCircleTextRegular, CodeRegular, CopyRegular, EraserRegular, EyeRegular, FileArrowUpRegular, FolderOpenRegular, PencilSimpleRegular } from 'purr/glyphs';
  import { flushSync, onMount, tick, untrack } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import { expandable } from '../shared/context.ts';
  import { formatSize, imageType, renderKind } from '../shared/files.ts';
  import type { DiffSummary, FileSummary, HunkData, Selection } from '../shared/types.ts';
  import FileTree from './FileTree.svelte';
  import ImageDiff from './ImageDiff.svelte';
  import RenderedFile from './RenderedFile.svelte';
  import type { CsvIndex } from './lib/csv.ts';
  import { addedLines, renderSide, renderedDiff, renderedPaths } from './lib/rendered.ts';
  import { DocDiff, type Fold } from './lib/md-diff.ts';
  import Composer from './gh/Composer.svelte';
  import Thread from './gh/Thread.svelte';
  import { type Block, type DiffReview, reviews } from './lib/gh-review.svelte.ts';
  import { type BlockLayout, heightAbove, layOut } from './lib/gh-threads.ts';
  import { type DiffPosition, app, hideWhitespace, highlightKey } from './lib/app.svelte.ts';
  import { lineEntries } from './lib/gh-issues.svelte.ts';
  import { type Tokens, highlight, prepare, segments } from './lib/highlighter.ts';
  import { wrappedOffsets, wrappedRows } from './lib/wrap.ts';
  import { caseSensitive, markSegments, matchesIn } from './lib/find.ts';
  import { finder } from './lib/finder.svelte.ts';
  import { cutWords, wordDiff } from './lib/worddiff.ts';
  import {
    ADDED,
    type Expansion,
    type FileRows,
    HUNK,
    REMOVED,
    SPACED,
    TAIL,
    buildRows,
    changesIn,
    isHead,
    moveTokens,
    noExpansion,
    rowHunks,
    rowMap,
    rowOfChange,
    rowsIn,
  } from './lib/rows.ts';
  import { type Anchor, type Knot, anchorAt, readKnots, rowAnchor, rowOfAnchor, yOf } from './lib/place.ts';

  let {
    summary,
    sel,
    readonly,
    fileActions,
    folderActions,
    tree = true,
    initial = null,
    onremove,
    oneditline,
    onresolve,
    onstage,
    changeActions,
    review,
    inset = 0,
  }: {
    summary: DiffSummary;
    sel: Record<string, SvelteSet<number>>;
    readonly: boolean;
    /** More entries for a file's context menu. */
    fileActions?: (f: FileSummary) => MaybeEntry[];
    /** More entries for a folder's context menu (right-click it in the tree), given the files under it. */
    folderActions?: (dir: string, files: FileSummary[]) => MaybeEntry[];
    /** Show the files as a folder tree beside the diff, to jump between them. */
    tree?: boolean;
    /** Where to open, from `position()` of the view this one replaces. */
    initial?: DiffPosition | null;
    /** Take changes out of the commit (offered in a changed line's menu). */
    onremove?: (selection: Selection) => void;
    /** Conflicts: keep one side (or both) of the conflict whose `<<<<<<<` is on new-side line `line` of `path`. */
    onresolve?: (path: string, line: number, side: 'ours' | 'theirs' | 'both') => void;
    /** Replace line `line` of the commit's version of file `path` with `text` (lines separated by \n). */
    oneditline?: (path: string, line: number, text: string) => Promise<boolean>;
    /**
     * Uncommitted changes: `sel` is what's staged, and picking lines stages or unstages them at once
     * (`on`). Files' `mixed` lines show as neither until picked.
     */
    onstage?: (path: string, lines: number[] | 'all', on: boolean) => void;
    /** More entries for a changed line's menu: its changes (two for a line whose whitespace changed), and the block of changes around it. */
    changeActions?: (f: FileSummary, line: number[], block: number[]) => MaybeEntry[];
    /** The pull request's review threads to show under the lines they're on, and commenting on lines. */
    review?: DiffReview;
    /** How much of the scroller's top a sticky bar above the diff covers (px): the view starts below it. */
    inset?: number;
  } = $props();

  // Fixed geometry (px). The CSS below pins elements to exactly these sizes.
  const HEAD = 34;
  const ROW = 19;
  const NOTE = 38;
  const PAD = 4;
  const GAP = 10;
  /** Block strip + old/new line numbers + marker; keep in sync with .gutter's CSS width. */
  const GUTTER = 90;
  /** How far beyond the viewport to render, so scrolling rarely shows unrendered rows. */
  const OVERSCAN = 1200;
  /** Files past the viewport whose contents are fetched ahead of time. */
  const PREFETCH = 4;
  /** Unchanged lines one click on a gap's arrow shows. */
  const STEP = 20;
  /** An image file's before and after, above its lines if it has any. */
  const IMG = 320;

  // Which files are collapsed as generated, and their grammars, come from the settings: when those
  // change, the summary's fetched again and those two taken from it, in place (nothing else can change).
  let fresh = $state.raw<Map<string, FileSummary> | null>(null);
  const files = $derived(
    fresh
      ? summary.files.map((f) => {
          const n = fresh!.get(f.path);
          return n ? { ...f, generated: n.generated, syntax: n.syntax } : f;
        })
      : summary.files,
  );
  let settingsSeen = app.settingsTick;
  $effect(() => {
    const tick = app.settingsTick;
    if (tick === settingsSeen) return;
    settingsSeen = tick;
    app.diff(summary.sha).then(
      (d) => {
        if (!alive) return;
        const before = untrack(() => files);
        fresh = new Map(d.files.map((f) => [f.path, f]));
        untrack(() => {
          const t = { ...tokens };
          files.forEach((f, i) => {
            if (f.generated !== before[i].generated) collapsed[i] = f.generated;
            if (f.syntax !== before[i].syntax && contents[i]) {
              delete t[i];
              queueHighlight(i, contents[i]);
            }
          });
          tokens = t;
        });
      },
      () => {},
    );
  });
  // Generated files (lockfiles etc.) start collapsed. The view is re-created per commit.
  let collapsed = $state<Record<number, boolean>>(
    untrack(() =>
      Object.fromEntries(
        summary.files.flatMap((f, i) =>
          (initial?.files?.includes(f.path) ? initial.collapsed.includes(f.path) : f.generated) ? [[i, true]] : [],
        ),
      ),
    ),
  );
  const generatedCount = $derived(files.filter((f) => f.generated).length);
  let contents = $state.raw<Record<number, FileRows>>({});
  let tokens = $state.raw<Record<number, Tokens>>({});
  let view = $state({ top: 0, bottom: 1000 });
  let filesEl: HTMLElement;
  let scroller: HTMLElement;
  let alive = true;

  // Editing a line in place (double-click it, or its menu): the row becomes a text field, which
  // grows by a row per line typed into it and pushes the rows below down.
  let editing = $state<{ i: number; r: number; text: string; orig: string } | null>(null);
  let saving = $state(false);

  // Review threads (and comments being written) sit under the rows they're on, as tall as they
  // were last measured (an estimate until first shown); one growing above the view keeps the view
  // where it was. Placing them takes a file's rows, so they appear as its contents come in.
  const SLOT_PAD = 6;
  const placedThreads = $derived.by(() => {
    const out: Record<number, ReturnType<DiffReview['blocks']>> = {};
    if (!review) return out;
    for (const k of Object.keys(contents)) out[+k] = review.blocks(files[+k].path, contents[+k]);
    return out;
  });
  let blockHeights = $state<Record<string, number>>({});
  function blockHeight(b: Block): number {
    const known = blockHeights[b.key] ?? reviews.heights.get(b.key);
    if (known !== undefined) return known;
    if (b.draft) return 190;
    const shut = 32 + 2 * SLOT_PAD;
    return reviews.isOpen(b.thread) ? shut + 64 + 90 * b.thread.comments.length : shut;
  }
  const blockLayout = $derived.by(() => {
    const out: Record<number, BlockLayout<Block>> = {};
    for (const [k, v] of Object.entries(placedThreads)) if (v.blocks.length) out[+k] = layOut(v.blocks, blockHeight);
    return out;
  });
  /** Height of file i's blocks under the rows before row r. */
  const blocksAbove = (i: number, r: number) => (blockLayout[i] ? heightAbove(blockLayout[i], r) : 0);

  function measureBlock(b: Block) {
    return (el: HTMLElement) => {
      const ro = new ResizeObserver(() => {
        const h = el.offsetHeight + 2 * SLOT_PAD;
        const was = blockHeight(b);
        if (!el.offsetHeight || h === was) return;
        if (scroller && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top) scroller.scrollTop += h - was;
        blockHeights[b.key] = h;
        reviews.heights.set(b.key, h);
      });
      ro.observe(el);
      return () => ro.disconnect();
    };
  }

  // A thread to bring into view (from the threads panel, or a comment just started): its file
  // first, then, once its contents are in, the thread.
  $effect(() => {
    const f = reviews.focus;
    if (!review || !f) return;
    const i = files.findIndex((x) => x.path === f.path);
    if (i < 0) return void (reviews.focus = null);
    const placed = placedThreads[i];
    // A thread shows with the diff: a rendered file goes back to it (and this runs again).
    if (rendered[i]) return void untrack(() => setRendered(i, false));
    untrack(() => {
      if (!scroller) return;
      if (!placed) return reveal(i);
      reviews.focus = null;
      const b = placed.blocks.find((x) => x.key === f.id);
      if (!b) {
        reveal(i);
        if (placed.elsewhere.some((t) => t.id === f.id)) tick().then(() => openAway(i));
        return;
      }
      const same = blockLayout[i]?.byRow.get(b.row) ?? [];
      let y = tops[i] + HEAD + lead(i) + rowY(i, b.row) + rowSpan(i, b.row) * ROW;
      for (const x of same) {
        if (x === b) break;
        y += blockHeight(x);
      }
      if (y < view.top + HEAD || y + Math.min(blockHeight(b), (view.bottom - view.top) / 2) > view.bottom) {
        scroller.scrollTop += y - view.top - (view.bottom - view.top) / 4;
        measure();
      }
    });
  });

  // A file's threads that have no line here, listed from its header.
  let away = $state<{ i: number; el: HTMLElement } | null>(null);
  function openAway(i: number) {
    const el = filesEl?.querySelector<HTMLElement>(`[data-away="${i}"]`);
    if (el) away = { i, el };
  }

  /** Rows a..b of file i the picked changes span, when they're all in file i; else why not. */
  function pickedRows(i: number): [number, number] | string {
    const f = files[i];
    const rows = contents[i];
    if (files.some((g) => g !== f && sel[g.path]?.size)) return 'Pick lines in one file to comment on them.';
    if (!rows) return 'Pick lines shown in the diff to comment on them.';
    let a = -1;
    let b = -1;
    for (let r = 0; r < rows.ci.length; r++) {
      if (changesIn(rows, r, r).some((c) => sel[f.path].has(c))) {
        if (a < 0) a = r;
        b = r;
      }
    }
    return a < 0 ? 'Pick lines shown in the diff to comment on them.' : [a, b];
  }

  /** "Comment on this line…" (or on the picked lines around it) in row r's menu. */
  function commentEntry(i: number, r: number): MaybeEntry {
    if (!review?.pr) return false;
    const rows = contents[i];
    const p = sel[files[i].path]?.size ? pickedRows(i) : null;
    const [a, b] = Array.isArray(p) && r >= p[0] && r <= p[1] ? p : [r, r];
    const why = review.why(rows, a, b);
    return {
      label: a === b ? 'Comment on this line…' : `Comment on ${b - a + 1} lines…`,
      icon: ChatCircleTextRegular,
      disabled: !!why,
      note: why ?? `On #${review.pr.number}`,
      run: () => review.compose(files[i].path, rows, a, b),
    };
  }

  /** Commenting on the picked lines, for the view's own buttons: why not, and how; null without a pull request. */
  export function pickedComment(): { why: string | null; run: () => void } | null {
    if (!review?.pr) return null;
    const i = files.findIndex((f) => sel[f.path]?.size);
    if (i < 0) return null;
    const p = pickedRows(i);
    if (typeof p === 'string') return { why: p, run: () => {} };
    const why = review.why(contents[i], p[0], p[1]);
    return { why, run: () => review.compose(files[i].path, contents[i], p[0], p[1]) };
  }

  // Wrapping long lines (settings): at the columns that fit the diff, or at most at a given one.
  let charWidth = $state(knownCharWidth);
  let paneWidth = $state(0);
  const cols = $derived.by(() => {
    const { wrap, wrapColumn } = app.display;
    if (wrap === 'none' || !charWidth || !paneWidth) return 0;
    const fit = Math.max(20, Math.floor((paneWidth - GUTTER - 20) / charWidth) - 1);
    return wrap === 'column' ? Math.min(wrapColumn, fit) : fit;
  });
  const editRows = $derived(
    editing ? editing.text.split('\n').reduce((n, l) => n + wrappedRows(l, cols), 0) : 1,
  );

  /** File i's rows: the summary's count until its contents (and any lines shown between hunks) are in. */
  const rowCount = (i: number) => contents[i]?.kind.length ?? files[i].rows - (hideWhitespace.value ? files[i].ws : 0);
  /** Where each of file i's rows starts, in rows, when some of its lines wrap; null when none can. */
  const wrapCache = new WeakMap<FileRows, { cols: number; at: Uint32Array }>();
  function wrapped(i: number): Uint32Array | null {
    const rows = contents[i];
    if (!cols || !rows || files[i].width <= cols) return null;
    let w = wrapCache.get(rows);
    if (w?.cols !== cols) wrapCache.set(rows, (w = { cols, at: wrappedOffsets(rows, cols) }));
    return w.at;
  }
  /** Rows row r of file i takes (the one being edited: what its field needs). */
  function rowSpan(i: number, r: number): number {
    if (editing?.i === i && editing.r === r) return editRows;
    const at = wrapped(i);
    return at ? at[r + 1] - at[r] : 1;
  }
  /** Y of row r in file i's lines. */
  function rowY(i: number, r: number): number {
    const at = wrapped(i);
    const y = (at ? at[r] : r) * ROW + blocksAbove(i, r);
    return editing?.i === i && editing.r < r ? y + (editRows - (at ? at[editing.r + 1] - at[editing.r] : 1)) * ROW : y;
  }
  // Markdown and CSV files can be shown rendered instead of as lines (the button in their header).
  // A rendered file is as tall as it was laid out, measured as it shows (and as it changes: images
  // loading, the width); until then, as it was last measured, or as its lines. Its rows aren't shown,
  // so nothing that works on them (picking, editing, gaps, threads, ⌘F) reaches it.
  let rendered = $state<Record<number, boolean>>(
    untrack(() =>
      Object.fromEntries(summary.files.flatMap((f, i) => (renderSide(f) && renderedPaths.has(f.path) ? [[i, true]] : []))),
    ),
  );
  const anyRendered = $derived(Object.values(rendered).some(Boolean));
  /** Rendered files' texts once loaded, or why they can't be shown; a table's rows, read with its text. */
  let renderTexts = $state.raw<Record<number, string | { error: string }>>({});
  /** The old texts of the files shown as the diff of their versions (an edited markdown file), once loaded; null when they can't be. */
  let renderOlds = $state.raw<Record<number, string | null>>({});
  /** What each of those diffs opened besides its changes, while this view lives (as the code diff's expansions). */
  const folds: Record<number, Fold> = {};
  const renderTables = new Map<number, CsvIndex>();
  let renderHeights = $state.raw<Record<number, number>>({});
  function heightKeys(i: number): [string, string] {
    const f = files[i];
    const sha = renderSide(f) === 'old' ? f.oldSha : f.newSha;
    // An uncommitted file's text has no blob yet: its token in the snapshot says which it is.
    const w = paneWidth || knownPaneWidth;
    return [`${f.path}:${/^0*$/.test(sha) ? (f.token ?? '') : sha}:${w}`, `${f.path}::${w}`];
  }
  function renderedHeight(i: number): number {
    if (renderHeights[i]) return renderHeights[i];
    const [exact, any] = heightKeys(i);
    return knownHeights.get(exact) ?? knownHeights.get(any) ?? Math.max(NOTE, linesHeight(i));
  }

  function measureRendered(i: number) {
    return (el: HTMLElement) => {
      // Its size as observed, not read back, which would lay the view out again after an earlier observer changed it.
      const ro = new ResizeObserver(([e]) => {
        const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
        if (!h || h === renderHeights[i]) return;
        renderHeights = { ...renderHeights, [i]: h };
        if (knownHeights.size > 500) knownHeights.clear();
        for (const key of heightKeys(i)) knownHeights.set(key, h);
      });
      ro.observe(el);
      return () => ro.disconnect();
    };
  }

  /** Show file i rendered, or as its diff again: a header stuck at the top stays, over the same place; else the view stays. */
  function setRendered(i: number, on: boolean) {
    if (on) renderedPaths.add(files[i].path);
    else renderedPaths.delete(files[i].path);
    if (editing?.i === i) editing = null;
    if (hoverBlock?.i === i) hoverBlock = null;
    if (on && (typeof renderTexts[i] === 'object' || renderOlds[i] === null)) {
      textAsked.delete(i);
      const t = { ...renderTexts };
      delete t[i];
      renderTexts = t;
      const o = { ...renderOlds };
      delete o[i];
      renderOlds = o;
    }
    const above = collapsed[i] ? 0 : view.top - tops[i];
    const stuck = above > 0 && above < fileHeight(i);
    const at = stuck ? placeIn(i, above) : null;
    rendered[i] = on;
    collapsed[i] = false;
    knotsOf.delete(i);
    placing = reading = null;
    if (!stuck || !scroller) return keepHeld();
    flushSync();
    if (!at || !showPlace(i, at)) {
      scroller.scrollTop += tops[i] - view.top;
      measure();
    }
    // Shown before it's laid out (or as it lays out): placed again as it is.
    if (on && at) placing = { i, at, until: performance.now() + 2000 };
  }

  // The place at the top of the view stays there as a file switches between its diff and rendered
  // view, and as a rendered file's layout changes (laid out, images loading, the width): see lib/place.ts.
  const renderEls = new Map<number, HTMLElement>();
  /** Rendered files' layouts, as last read. */
  const knotsOf = new Map<number, Knot[]>();
  let bodies = $state(0);
  /** File i just switched to rendered at place `at`: placed again as it lays out, until the reader scrolls or it's all there. */
  let placing: { i: number; at: Anchor; until: number } | null = null;
  /** Where the view was in the rendered file at its top, as of the last scroll: what a layout change keeps there. */
  let reading: { i: number; at: Anchor } | null = null;

  function renderedBody(i: number) {
    return (el: HTMLElement) => {
      renderEls.set(i, el);
      untrack(() => bodies++);
      return () => {
        if (renderEls.get(i) === el) renderEls.delete(i);
        knotsOf.delete(i);
      };
    };
  }

  onMount(() => {
    const el = filesEl.closest('[data-scroller]') as HTMLElement;
    // Read as the reader scrolls, not as the view's measured: a layout change can scroll it (scroll anchoring) before it's held.
    const read = () => {
      if (!anyRendered) return;
      const top = el.getBoundingClientRect().top + inset - filesEl.getBoundingClientRect().top;
      const i = top > 0 && top < tops[files.length] ? rowAt(tops, top) : -1;
      const k = knotsOf.get(i);
      reading = k && rendered[i] && !collapsed[i] ? { i, at: anchorAt(k, top - tops[i]) } : null;
    };
    const drop = () => (placing = null);
    const input = ['wheel', 'touchstart', 'pointerdown'] as const;
    el.addEventListener('scroll', read, { passive: true });
    for (const t of input) el.addEventListener(t, drop, { passive: true });
    document.addEventListener('keydown', drop);
    return () => {
      el.removeEventListener('scroll', read);
      for (const t of input) el.removeEventListener(t, drop);
      document.removeEventListener('keydown', drop);
    };
  });

  /** The place in file i's text `above` px into its body, as it shows now; null when that isn't known yet. */
  function placeIn(i: number, above: number): Anchor | null {
    if (rendered[i]) {
      const el = renderEls.get(i);
      const text = shownText.get(i);
      return el && typeof text === 'string' ? anchorAt(readKnots(el, text), above) : null;
    }
    const rows = contents[i];
    if (!rows) return null;
    const y = above - lead(i);
    const [r] = rowsIn(rows.kind.length, (k) => rowY(i, k), y, y + 1);
    return rowAnchor(rows, r, r < rows.kind.length ? (y - rowY(i, r)) / (rowSpan(i, r) * ROW) : 0, renderSide(files[i]) ?? 'new');
  }

  /** Scroll place `at` of file i to the top of the view, as file i shows now; false when it can't be found yet. */
  function showPlace(i: number, at: Anchor): boolean {
    let y: number;
    if (rendered[i]) {
      const el = renderEls.get(i);
      const text = shownText.get(i);
      // Until its height is measured, the view's layout (which files are shown) doesn't have it.
      if (!el || typeof text !== 'string' || Math.abs(el.offsetHeight - renderedHeight(i)) > 1) return false;
      const knots = readKnots(el, text);
      knotsOf.set(i, knots);
      y = yOf(knots, at);
    } else {
      const rows = contents[i];
      if (!rows) return false;
      const { r, frac } = rowOfAnchor(rows, at, renderSide(files[i]) ?? 'new');
      y = lead(i) + rowY(i, r) + frac * rowSpan(i, r) * ROW;
    }
    const drift = tops[i] + y - view.top;
    if (Math.abs(drift) >= 0.5) {
      scroller.scrollTop += drift;
      measure();
    }
    return true;
  }

  $effect(() => {
    void renderHeights;
    void paneWidth;
    void bodies;
    untrack(holdPlace);
  });

  /** Rendered files' layouts changed: read them again, and keep the place at the top of the view there. */
  function holdPlace() {
    if (!scroller) return;
    measure();
    if (placing && (performance.now() > placing.until || !rendered[placing.i])) placing = null;
    const p = placing;
    const top = p ? p.i : (held?.k ?? -1);
    let placed = false;
    for (const [i, el] of renderEls) {
      const text = shownText.get(i);
      if (typeof text !== 'string') continue;
      const above = view.top - tops[i];
      const at = i !== top ? null : p ? p.at : reading?.i === i && above > 0 && above < fileHeight(i) ? reading.at : null;
      if (at && showPlace(i, at)) {
        placed = true;
        reading = { i, at };
      } else knotsOf.set(i, readKnots(el, text));
    }
    // Its block is laid out, and the next one: nothing left to wait for.
    if (p && placed && knotsOf.get(p.i)?.some((k, j, all) => j < all.length - 1 && k.line > p.at.line)) placing = null;
  }

  type RenderedView = RenderedText & { changed?: ReadonlySet<number>; old?: string };
  /**
   * What file i shows rendered: its text (a table's rows read with it) and the lines its diff adds, or for an edited
   * markdown file its old text, once both are in, here or already loaded; until then, what it showed last (in an
   * earlier view), if anything; or why it can't be. (Without its old text, an edited file shows its new one marked.)
   */
  function renderedView(i: number, rows: FileRows | undefined): RenderedView | { error: string } | undefined {
    const f = files[i];
    const t = renderTexts[i];
    shownText.delete(i);
    if (typeof t === 'object') return t;
    const got = t === undefined ? app.renderedTextIn(summary, i, renderSide(f)!) : { text: t, table: renderTables.get(i) };
    const old = renderedDiff(f) ? (renderOlds[i] !== undefined ? renderOlds[i] : app.renderedTextIn(summary, i, 'old')?.text) : null;
    // A new file is all new: marking every line of it would mark nothing.
    const hunks = f.status === 'A' || !f.rows || typeof old === 'string' ? null : (rows?.hunks ?? app.contentsIn(summary, i));
    if (!got || hunks === undefined || old === undefined) {
      const last = lastShown.get(f.path);
      if (last) shownText.set(i, last.text);
      return last;
    }
    const view = { ...got, changed: hunks ? addedLines(hunks, hideWhitespace.value) : undefined, old: old ?? undefined };
    lastShown.set(f.path, view, view.text.length);
    shownText.set(i, view.text);
    return view;
  }
  /** The text each rendered file shows now (it may be an earlier version's, until its own is in): what places in it are read against. */
  const shownText = new Map<number, string>();

  /** Fetch file i's text (and read its table, or diff its versions) as the pointer comes to its button, so it shows rendered as it's clicked. */
  function warmRendered(i: number) {
    const side = renderSide(files[i]);
    if (!side || rendered[i]) return;
    const text = app.renderedText(summary, i, side);
    text.catch(() => {});
    if (renderedDiff(files[i]))
      Promise.all([app.renderedText(summary, i, 'old'), text]).then(
        ([a, b]) => DocDiff.warm(a.text, b.text),
        () => {},
      );
  }

  /** Height of what comes before each file's lines: its images. */
  const leads = $derived(files.map((f) => (imageType(f.path) && f.oldSha !== f.newSha ? IMG : 0)));
  const lead = (i: number) => leads[i];
  const linesHeight = (i: number) => rowY(i, rowCount(i)) + PAD;
  const bodyHeight = (i: number) =>
    rendered[i] ? renderedHeight(i) : lead(i) + (files[i].rows ? linesHeight(i) : lead(i) ? 0 : NOTE);
  /** tops[i] = y of file i; tops[n] = total height (plus one trailing gap). */
  const tops = $derived(offsets(files.length, (i) => HEAD + (collapsed[i] ? 0 : bodyHeight(i)) + GAP));
  const fileHeight = (i: number) => tops[i + 1] - tops[i] - GAP;

  /** [first, end) of the files overlapping the viewport plus overscan; the same array while they stay the same, as they do for most frames of scrolling. */
  let lastRange: [number, number] = [0, 0];
  const range = $derived.by(() => {
    const [a, b] = variableRange(tops, view.top, view.bottom - view.top, OVERSCAN);
    return a === lastRange[0] && b === lastRange[1] ? lastRange : (lastRange = [a, b]);
  });
  const visible = $derived(Array.from({ length: range[1] - range[0] }, (_, k) => range[0] + k));

  /** File i's rows near the viewport. */
  function rowRange(i: number): number[] {
    const y = tops[i] + HEAD + lead(i);
    // Rows of varying height are searched for, not listed: this runs for every frame of scrolling.
    const [a, b] =
      blockLayout[i] || wrapped(i)
        ? rowsIn(rowCount(i), (r) => rowY(i, r), view.top - OVERSCAN - y, view.bottom + OVERSCAN - y)
        : fixedRange(rowCount(i), ROW, view.top - OVERSCAN - y, view.bottom - view.top + 2 * OVERSCAN);
    const out: number[] = [];
    for (let r = a; r < b; r++) out.push(r);
    return out;
  }

  // Scroll position -> view, measured synchronously in the scroll event so the new rows
  // are in the DOM before the frame paints.
  /** The view's been measured: until then (the first layout, unless it opens at a place) it's only a guess, not worth loading. */
  let measured = $state(false);
  function measure() {
    if (!filesEl || !scroller) return;
    const top = scroller.getBoundingClientRect().top + inset - filesEl.getBoundingClientRect().top;
    const height = scroller.clientHeight - inset;
    if (top !== view.top || view.bottom - view.top !== height) view = { top, bottom: top + height };
    measured = true;
    if (paneWidth !== filesEl.clientWidth) paneWidth = knownPaneWidth = filesEl.clientWidth;
    const k = view.top > 0 && view.top < tops[files.length] ? rowAt(tops, view.top) : -1;
    held = k >= 0 ? { k, offset: view.top - tops[k] } : null;
  }

  // With wrapping, files change height as their contents come in (or the width changes), with
  // review threads as they're placed, and rendered files as they're laid out: the file at the top of
  // the view stays where it was.
  let held: { k: number; offset: number } | null = null;
  $effect(() => {
    void tops;
    if (cols || review || anyRendered) untrack(keepHeld);
  });

  /** Scroll the file at the top of the view (as last measured) back to where it was, after files above it changed height. */
  function keepHeld() {
    const a = held;
    if (!a || !scroller || a.k >= files.length) return;
    const was = view.top;
    const drift = tops[a.k] + Math.min(a.offset, tops[a.k + 1] - tops[a.k]) - was;
    if (Math.abs(drift) < 1) return;
    const j = jump;
    scroller.scrollTop += drift;
    measure();
    // A file the tree jumped to, too near the end to reach the top, still shows as picked.
    if (j && Math.abs(j.top - was) < 1) jump = { i: j.i, top: view.top };
  }

  // Read once laid out (and again when the font loads) rather than forcing a layout as the view mounts.
  function measureChars(el: HTMLElement) {
    const ro = new ResizeObserver(([e]) => {
      if (e.contentRect.width) charWidth = knownCharWidth = e.contentRect.width / 100;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }

  // The bar above it changing height moves where the view starts (before it's measured, the first measure will do).
  $effect(() => {
    void inset;
    if (untrack(() => measured)) untrack(measure);
  });

  onMount(() => {
    scroller = filesEl.closest('[data-scroller]') as HTMLElement;
    scroller.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(filesEl);
    ro.observe(scroller.firstElementChild ?? filesEl);
    // The observer's first call measures once laid out, after whatever moves the view as it mounts
    // (the commit view scrolling to the top): reading it now would force a layout of the new view.
    // (It doesn't call while the view isn't shown.)
    if (!initial) setTimeout(() => alive && !measured && measure(), 100);
    else {
      measure();
      const k = initial.path === null ? -1 : files.findIndex((f) => f.path === initial.path);
      if (k >= 0) scroller.scrollTop += tops[k] + Math.min(initial.offset, fileHeight(k)) - view.top;
      else scroller.scrollTop = initial.scrollTop;
      measure();
    }
    // Grammars load while the first contents do.
    prepare(files.slice(near[0], near[1]).map((f) => f.path));
    return () => {
      alive = false;
      scroller.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  });

  /** [first, end) of the files worth loading and highlighting: those near the viewport, and a few past it. */
  const near = $derived([range[0], Math.min(files.length, range[1] + PREFETCH)]);

  // Fetch the contents of files as they come near the viewport, one batch at a time: the next is
  // what's near when the last lands, so scrolling fast doesn't fetch every file it goes past.
  const requested = new Set<number>();
  let fetching = false;
  /** Files came near while a batch was on its way: look again once it's in. */
  let skipped = false;
  let behind = $state(0);
  $effect(() => {
    void behind;
    if (!measured) return;
    const want: number[] = [];
    for (let i = near[0]; i < near[1]; i++) {
      if (files[i].rows && !collapsed[i] && !requested.has(i)) want.push(i);
    }
    if (!want.length) return;
    // What's already loaded (prefetched, or unchanged in a new snapshot) shows without waiting for the rest.
    const have = want.filter((i) => app.hasContents(summary, i));
    for (const i of have) requested.add(i);
    if (have.length) load(have);
    if (have.length === want.length) return;
    if (fetching) return void (skipped = true);
    const rest = want.filter((i) => !have.includes(i));
    for (const i of rest) requested.add(i);
    fetching = true;
    load(rest).finally(() => {
      fetching = false;
      if (skipped && alive) behind++;
      skipped = false;
    });
  });

  // Rendered files' texts, as they come near the viewport.
  const textAsked = new Set<number>();
  $effect(() => {
    if (!measured) return;
    for (let i = near[0]; i < near[1]; i++) {
      const side = rendered[i] && !collapsed[i] && !textAsked.has(i) ? renderSide(files[i]) : null;
      if (!side) continue;
      textAsked.add(i);
      // A file shown rendered is shown so in the commits either side too: their texts are wanted.
      app.prefetchAround();
      const done = (t: string | { error: string }) => alive && (renderTexts = { ...renderTexts, [i]: t });
      app.renderedText(summary, i, side).then(
        (r) => {
          if (r.table) renderTables.set(i, r.table);
          done(r.text);
        },
        (e: Error) => done({ error: e.message || "Can't show it rendered" }),
      );
      // Its old version, to show the diff of the two; without it (too big, say), the new one marked.
      if (renderedDiff(files[i]))
        app.renderedText(summary, i, 'old').then(
          (r) => alive && (renderOlds = { ...renderOlds, [i]: r.text }),
          () => alive && (renderOlds = { ...renderOlds, [i]: null }),
        );
    }
  });

  function load(want: number[]) {
    return app.fileContents(summary, want).then(
      (res) => {
        if (!alive) return;
        const next = { ...contents };
        for (const i of want) next[i] = build(i, res[i]);
        contents = next;
      },
      (e) => {
        for (const i of want) requested.delete(i);
        toast.error(e);
      },
    );
  }

  /** File i's rows from its hunks, with the lines shown between them and whitespace as the switch has it. */
  const build = (i: number, hunks: HunkData[]) =>
    buildRows(hunks, expandable(files[i]), expansions[i] ?? noExpansion(), hideWhitespace.value);

  /** The highlighting asked for of each file's rows (its key), until it's in or dropped. */
  const asked = new WeakMap<FileRows, string>();

  function queueHighlight(i: number, rows: FileRows) {
    const key = highlightKey(summary, i, files[i].syntax, expansions[i], rows.ws);
    if (asked.get(rows) === key) return;
    asked.set(rows, key);
    // How far it is from the view: none when any of it is in view, however far up it starts.
    const distance = () => Math.max(0, tops[i] - view.bottom, view.top - tops[i + 1]);
    // A file scrolled past before its turn is dropped, and asked for again when it's back.
    const want = () => alive && contents[i] === rows && i >= near[0] && i < near[1];
    highlight(key, files[i].path, rowHunks(rows), distance, want, files[i].syntax).then((t) => {
      if (t === undefined) {
        if (asked.get(rows) === key) asked.delete(rows);
      } else if (t && alive && contents[i] === rows) tokens = { ...tokens, [i]: t };
    });
  }

  // Highlighting for the files near the view, as their contents come in.
  $effect(() => {
    for (let i = near[0]; i < near[1]; i++) {
      const rows = contents[i];
      if (rows && !collapsed[i] && !rendered[i]) untrack(() => queueHighlight(i, rows));
    }
  });

  // Unchanged lines between hunks: arrows on a hunk's header show more of the gap above it, from
  // its bottom (up) or its top (down, continuing the hunk before). The old file is loaded the
  // first time; it reads the same as the new one there.
  const expansions: Record<number, Expansion> = {};
  let opening = $state<Record<number, boolean>>({});

  async function expand(i: number, k: number, side: 'top' | 'bottom') {
    const x = (expansions[i] ??= noExpansion());
    const loaded = !!x.file;
    if (!x.file) {
      if (opening[i]) return;
      opening[i] = true;
      try {
        x.file = await app.oldLines(summary.sha, i);
      } catch (e) {
        toast.error(e);
        return;
      } finally {
        opening[i] = false;
      }
      if (!alive) return;
    }
    const before = contents[i];
    // Its size is known once the file is (after the last hunk); a short gap shows all at once.
    const left = (loaded ? before : build(i, before.hunks)).hidden[k] ?? 0;
    const n = left <= STEP ? left : STEP;
    // Nothing comes before the first hunk's gap but the file's start, so it only grows upwards.
    const s = k === 0 ? 'bottom' : side;
    x[s][k] = (x[s][k] ?? 0) + n;
    replaceRows(i, build(i, before.hunks));
  }

  /** File i shown as `rows` now: lines keep their highlighting (and the line being edited stays so) where they moved to. */
  function replaceRows(i: number, rows: FileRows) {
    const before = contents[i];
    const moved = rowMap(before, rows);
    if (tokens[i]) tokens = { ...tokens, [i]: moveTokens(tokens[i], before, rows, moved) };
    if (editing?.i === i) {
      const n = before.n[editing.r];
      const r = moved[editing.r] >= 0 ? moved[editing.r] : rows.n.findIndex((m, k) => m === n && !isHead(rows.kind[k]));
      if (r >= 0) editing.r = r;
      else editing = null;
    }
    hoverBlock = null;
    contents = { ...contents, [i]: rows };
    queueHighlight(i, rows);
  }

  // Hiding whitespace (or showing it again) rebuilds every file loaded; the file at the top of the view stays there.
  $effect(() => {
    const ws = hideWhitespace.value;
    untrack(() => {
      for (const k of Object.keys(contents)) {
        const i = Number(k);
        if (contents[i].ws !== ws) replaceRows(i, build(i, contents[i].hunks));
      }
      keepHeld();
    });
  });

  // ⌘F: matches of the find bar's query in every file's lines, collapsed files included (all
  // contents are loaded for it), in order. The bar is App's; this view is one of its sources.
  const query = $derived(finder.open ? finder.query : '');
  const found = $derived.by(() => {
    const out: { i: number; r: number; start: number }[] = [];
    if (!query) return out;
    const sensitive = caseSensitive(query);
    files.forEach((_, i) => {
      const rows = contents[i];
      if (!rows || rendered[i]) return;
      for (let r = 0; r < rows.kind.length; r++) {
        if (isHead(rows.kind[r])) continue;
        for (const start of matchesIn(rows.text[r], query, sensitive)) out.push({ i, r, start });
      }
    });
    return out;
  });
  /** Match starts by file, then row. */
  const hits = $derived.by(() => {
    const out = new Map<number, Map<number, number[]>>();
    for (const { i, r, start } of found) {
      let f = out.get(i);
      if (!f) out.set(i, (f = new Map()));
      const at = f.get(r);
      if (at) at.push(start);
      else f.set(r, [start]);
    }
    return out;
  });
  const source = {
    get el() {
      return filesEl;
    },
    count: () => found.length,
    show: (k: number) => showMatch(found[k]),
  };
  const hitNow = $derived(found[finder.currentIn(source)] ?? null);

  // Words changed within a line, worked out as its rows are shown.
  const words = new WeakMap<FileRows, (r: number) => number[] | null>();

  /** Row r of file i in runs: highlighted (`c`), changed words (`w`), find's matches (`m`, at `at`); null when it's plain text. */
  function lineSegments(i: number, r: number, rows: FileRows, tok: Tokens | undefined, at: number[] | undefined) {
    const text = rows.text[r];
    let diff = words.get(rows);
    if (!diff) words.set(rows, (diff = wordDiff(rows)));
    const changed = diff(r);
    if (!tok && !changed && !at) return null;
    const segs: { t: string; c: string; w?: boolean; m?: number }[] = tok ? segments(tok, r, text) : [{ t: text, c: '' }];
    const cut = changed ? cutWords(segs, changed) : segs;
    return at ? markSegments(cut, at, finder.query.length, hitNow?.i === i && hitNow.r === r ? hitNow.start : -1) : cut;
  }

  /**
   * Row r's code, built directly rather than as a block per run (rows mount by the hundred while
   * scrolling). Given its file's rows, highlighting and matches, so it's redone when those change.
   */
  function code(i: number, r: number, rows: FileRows, tok: Tokens | undefined, at: number[] | undefined) {
    return (el: HTMLElement) => {
      const segs = lineSegments(i, r, rows, tok, at);
      el.textContent = '';
      if (!segs) el.append(rows.text[r]);
      for (const seg of segs ?? []) {
        if (!seg.m && !seg.c && !seg.w) {
          el.append(seg.t);
          continue;
        }
        const run = document.createElement(seg.m ? 'mark' : 'span');
        run.className = [seg.m && 'hit', seg.m === 2 && 'now', seg.c, seg.w && 'wd'].filter(Boolean).join(' ');
        run.textContent = seg.t;
        el.append(run);
      }
      if (rows.eof[r]) {
        const eof = document.createElement('span');
        eof.className = 'eof';
        eof.textContent = '⏎̸';
        el.append(eof);
      }
    };
  }

  // The tooltips of a line's gutter and end, registered as the pointer first reaches one (its
  // pointerover comes before the pointerenter they show on) rather than for every row mounted.
  const tipped = new WeakSet<Element>();
  function lineTip(e: PointerEvent, i: number) {
    const el = e.target as HTMLElement;
    if (tipped.has(el) || !el.matches('.line .blk, .line .mark, .line .eof')) return;
    tipped.add(el);
    tooltip(el, () => {
      if (el.classList.contains('eof')) return 'No newline at end of file';
      const rows = contents[i];
      const r = Number(el.closest<HTMLElement>('[data-r]')?.dataset.r ?? -1);
      if (!rows || r < 0) return null;
      if (el.classList.contains('mark')) return rows.kind[r] === SPACED ? 'Only whitespace changed' : null;
      return rows.ci[r] >= 0 && !readonly ? (onstage ? 'Stage or unstage this block' : 'Pick this block') : null;
    });
  }

  onMount(() => finder.register(source));

  // Searching needs every file's lines: load the ones not loaded yet.
  $effect(() => {
    if (!query) return;
    const want = untrack(() => files.flatMap((f, i) => (f.rows && !contents[i] && !requested.has(i) ? [i] : [])));
    if (!want.length) return;
    for (const i of want) requested.add(i);
    app.fileContents(summary, want).then(
      (res) => {
        if (!alive) return;
        const next = { ...contents };
        for (const i of want) if (!next[i]) next[i] = build(i, res[i]);
        contents = next;
      },
      (e) => {
        for (const i of want) requested.delete(i);
        toast.error(e);
      },
    );
  });

  async function showMatch(m: { i: number; r: number; start: number } | undefined) {
    if (!m || !scroller) return;
    if (collapsed[m.i]) {
      collapsed[m.i] = false;
      flushSync();
    }
    const y = tops[m.i] + HEAD + lead(m.i) + rowY(m.i, m.r);
    if (y < view.top + HEAD + ROW || y > view.bottom - 2 * ROW) {
      scroller.scrollTop += y - view.top - (view.bottom - view.top) / 3;
      measure();
    }
    await tick();
    filesEl.querySelector('mark.now')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // The file tree, beside the diff when there's room for it.
  const showTree = $derived(tree && files.length > 0);
  const TREE_WIDTH = 240;
  const savedTreeWidth = persisted('legit:tree-width', TREE_WIDTH);
  let treeWidth = $state(savedTreeWidth.value);

  let summaryHeight = $state(0);
  let treeNatural = $state(0);
  /**
   * The side pane's height: the part of the view the diff is in, so both ends of the file list can
   * always be scrolled to; beside a shorter diff, all the side needs, as far as it fits on screen.
   */
  const sideHeight = $derived.by(() => {
    const filesHeight = Math.max(0, tops[files.length] - GAP);
    const fits = view.bottom - Math.max(view.top, 0);
    const need = summaryHeight + treeNatural;
    if (filesHeight < need) return Math.min(need, fits);
    return Math.max(0, Math.min(view.bottom, filesHeight) - Math.max(view.top, 0));
  });

  /** Where the last jump left the diff, so a file too near the end to reach the top still shows as picked. */
  let jump = $state<{ i: number; top: number } | null>(null);
  const current = $derived(
    jump && Math.abs(jump.top - view.top) < 1 ? jump.i : view.top < 0 ? -1 : rowAt(tops, view.top + 1),
  );

  function reveal(i: number) {
    if (!scroller) return;
    if (collapsed[i]) {
      collapsed[i] = false;
      flushSync();
    }
    scroller.scrollTop += tops[i] - view.top;
    measure();
    jump = { i, top: view.top };
  }

  /** Where the view is, to open the next one (of the rewritten commit) at the same place. */
  export function position(): DiffPosition {
    const k = view.top >= 0 ? rowAt(tops, view.top) : -1;
    const at = k >= 0 && k < files.length ? k : -1;
    return {
      path: at >= 0 ? files[at].path : null,
      offset: at >= 0 ? view.top - tops[at] : 0,
      scrollTop: scroller?.scrollTop ?? 0,
      collapsed: files.filter((_, i) => collapsed[i]).map((f) => f.path),
      files: files.map((f) => f.path),
      shown: visible.map((i) => files[i].path),
    };
  }

  const totals = $derived(files.reduce((t, f) => ({ a: t.a + f.added, r: t.r + f.removed, ws: t.ws + f.ws }), { a: 0, r: 0, ws: 0 }));
  /** Every change of file f only changes whitespace. */
  const onlyWhitespace = (f: FileSummary) => f.ws > 0 && 2 * f.ws === changes(f);

  // Selection (split), or what's staged. A file with no line changes (binary, mode-only) uses index 0 as "whole file".
  const changes = (f: FileSummary) => f.added + f.removed;
  const mixed = $derived(new Map(files.flatMap((f) => (f.mixed?.length ? [[f.path, new Set(f.mixed)]] : []))));
  function fileState(f: FileSummary): 'none' | 'some' | 'all' {
    const n = sel[f.path].size;
    if (onstage && (f.unshown || [...(mixed.get(f.path) ?? [])].some((c) => !sel[f.path].has(c)))) return 'some';
    return n === 0 ? 'none' : n >= Math.max(1, changes(f)) ? 'all' : 'some';
  }

  function toggleFile(f: FileSummary) {
    if (readonly) return;
    const s = sel[f.path];
    const on = fileState(f) !== 'all';
    if (!on) s.clear();
    else for (let k = 0; k < Math.max(1, changes(f)); k++) s.add(k);
    onstage?.(f.path, 'all', on);
  }

  /** Staging: lines picked are staged or unstaged together, now. */
  function stageLines(path: string, lines: Iterable<number>, on: boolean) {
    const list = [...lines];
    if (onstage && list.length) onstage(path, list, on);
  }

  function toggleHunk(i: number, headerRow: number) {
    const f = files[i];
    if (readonly || !f.partial) return toggleFile(f);
    const rows = contents[i];
    let end = headerRow + 1;
    while (end < rows.kind.length && !isHead(rows.kind[end])) end++;
    const idx = changesIn(rows, headerRow, end - 1);
    const s = sel[f.path];
    const on = !idx.every((c) => s.has(c));
    for (const c of idx) on ? s.add(c) : s.delete(c);
    stageLines(f.path, idx, on);
  }

  function toggleCollapsed(i: number) {
    const above = view.top - tops[i];
    collapsed[i] = !collapsed[i];
    // Keep a stuck header where it is instead of jumping past the file.
    if (above > 0 && scroller) {
      scroller.scrollTop -= above;
      measure();
    }
  }

  // Drag-select: mousedown picks add/remove, dragging applies it to every change crossed (`last`
  // is a row). Starting on the block strip (left of the line numbers) works in whole blocks: runs
  // of consecutive changed lines.
  let drag: { path: string; on: boolean; last: number; block: boolean; touched: Set<number> } | null = null;
  let hoverBlock = $state<{ i: number; a: number; b: number } | null>(null);

  /** Rows [a, b] of the run of consecutive changed lines around row r. */
  function blockAt(rows: FileRows, r: number): [number, number] {
    let a = r;
    let b = r;
    while (a > 0 && rows.ci[a - 1] >= 0) a--;
    while (b + 1 < rows.ci.length && rows.ci[b + 1] >= 0) b++;
    return [a, b];
  }

  const onStrip = (e: Event) => !!(e.target as HTMLElement).closest('.blk');
  let anchor: { path: string; ci: number } | null = null;

  /** Pick (or unpick) the changes of rows a to b. */
  function setRange(path: string, rows: FileRows, a: number, b: number, on: boolean, touched?: Set<number>) {
    const s = sel[path];
    for (const c of changesIn(rows, a, b)) {
      on ? s.add(c) : s.delete(c);
      touched?.add(c);
    }
  }

  /** How much of row r's changes is picked: 0, 1 (half of a SPACED row's two) or 2 (all). */
  function pickedOf(path: string, rows: FileRows, r: number): 0 | 1 | 2 {
    const s = sel[path];
    const a = s.has(rows.ci[r]);
    if (rows.c2[r] < 0) return a ? 2 : 0;
    const b = s.has(rows.c2[r]);
    return a && b ? 2 : a || b ? 1 : 0;
  }

  /** Row r has a change staged in a version that's neither side's, and not picked. */
  function mixedAt(path: string, rows: FileRows, r: number): boolean {
    const m = mixed.get(path);
    return !!onstage && !!m && changesIn(rows, r, r).some((c) => m.has(c) && !sel[path].has(c));
  }

  /** The end of a drag: what it crossed is staged or unstaged in one go. */
  function endDrag() {
    if (drag) stageLines(drag.path, drag.touched, drag.on);
    drag = null;
  }

  function rowOf(e: Event): number {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-r]');
    return el ? Number(el.dataset.r) : -1;
  }

  // Picking starts on the gutter (line numbers, strip), or with a plain click on the code; a drag
  // over the code selects its text instead, to copy.
  let pending: { i: number; r: number; x: number; y: number } | null = null;

  function down(e: MouseEvent, i: number) {
    if ((e.target as HTMLElement).closest('.editor, .xp, .gh-slot, .resolve')) return;
    const r = rowOf(e);
    const rows = contents[i];
    if (rows?.kind[r] === TAIL && e.button === 0) return void expand(i, rows.gap[r], 'top');
    if (readonly || r < 0 || !rows || e.button !== 0) return;
    if (rows.kind[r] === HUNK) return toggleHunk(i, r);
    const ci = rows.ci[r];
    if (ci < 0) return;
    const f = files[i];
    if (!e.shiftKey && f.partial && !(e.target as HTMLElement).closest('.gutter')) {
      pending = { i, r, x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    if (!f.partial) return toggleFile(f);
    const s = sel[f.path];
    const touched = new Set<number>();
    // A line whose staged version is neither side's is staged with the rest of its block.
    const whole = onStrip(e) || mixedAt(f.path, rows, r);
    if (whole) {
      const [a, b] = blockAt(rows, r);
      const all = changesIn(rows, a, b).every((c) => s.has(c));
      setRange(f.path, rows, a, b, !all, touched);
      drag = { path: f.path, on: !all, last: r, block: true, touched };
      anchor = { path: f.path, ci };
      return;
    }
    const from = e.shiftKey && anchor?.path === f.path ? rowOfChange(rows, anchor.ci) : -1;
    if (from >= 0) {
      const on = s.has(anchor!.ci);
      setRange(f.path, rows, from, r, on, touched);
      stageLines(f.path, touched, on);
      return;
    }
    const on = pickedOf(f.path, rows, r) < 2;
    setRange(f.path, rows, r, r, on, touched);
    drag = { path: f.path, on, last: r, block: false, touched };
    anchor = { path: f.path, ci };
  }

  function up(e: MouseEvent) {
    endDrag();
    const p = pending;
    pending = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) return;
    const rows = contents[p.i];
    const ci = rows?.ci[p.r] ?? -1;
    if (ci < 0) return;
    const path = files[p.i].path;
    anchor = { path, ci };
    const touched = new Set<number>();
    // A line whose staged version is neither side's is staged with the rest of its block.
    if (mixedAt(path, rows, p.r)) {
      const [a, b] = blockAt(rows, p.r);
      setRange(path, rows, a, b, true, touched);
      return stageLines(path, touched, true);
    }
    const on = pickedOf(path, rows, p.r) < 2;
    setRange(path, rows, p.r, p.r, on, touched);
    stageLines(path, touched, on);
  }

  function over(e: MouseEvent, i: number) {
    const r = rowOf(e);
    const rows = contents[i];
    if (!rows || r < 0) return;
    const ci = rows.ci[r];
    // Preview the block the strip would toggle.
    const strip = !readonly && ci >= 0 && onStrip(e);
    if (strip) {
      const [a, b] = blockAt(rows, r);
      if (hoverBlock?.i !== i || hoverBlock.a !== a) hoverBlock = { i, a, b };
    } else if (hoverBlock) hoverBlock = null;
    if (!drag || drag.path !== files[i].path || ci < 0) return;
    setRange(drag.path, rows, drag.last, r, drag.on, drag.touched);
    if (drag.block) {
      const [a, b] = blockAt(rows, r);
      setRange(drag.path, rows, a, b, drag.on, drag.touched);
    }
    drag.last = r;
  }

  /** Row r of file i is a line of the commit's version of a text file (added or unchanged). */
  function canEdit(i: number, r: number): boolean {
    const f = files[i];
    const rows = contents[i];
    return !!oneditline && !readonly && f.partial && f.status !== 'D' && !!rows && !isHead(rows.kind[r]) && rows.n[r] > 0;
  }

  /** Focus the field when it's first shown, not each time scrolling mounts it again. */
  let focusEditor = false;

  function startEdit(i: number, r: number) {
    if (saving || !canEdit(i, r)) return;
    // The line ending isn't part of the text (the server keeps the file's).
    const text = contents[i].text[r].replace(/\r$/, '');
    editing = { i, r, text, orig: text };
    focusEditor = true;
  }

  async function saveEdit() {
    if (!editing || saving || !oneditline) return;
    const { i, r, text, orig } = editing;
    if (text === orig) {
      editing = null;
      return;
    }
    saving = true;
    try {
      if (await oneditline(files[i].path, contents[i].n[r], text)) editing = null;
    } finally {
      saving = false;
    }
  }

  function editorKey(e: KeyboardEvent) {
    // The field's keys are its own (Esc mustn't also clear the picked lines, say).
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = null;
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }
  }

  // Leaving the field closes it if nothing was typed. (Removing the field blurs it too.)
  function closeUnchanged() {
    if (editing && editing.text === editing.orig && !saving) editing = null;
  }

  function attachEditor(el: HTMLTextAreaElement) {
    if (!focusEditor) return;
    focusEditor = false;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }

  /** Picked changes of every file, as a selection. */
  function picked(): Selection {
    const out: Selection = {};
    for (const f of files) if (sel[f.path].size) out[f.path] = [...sel[f.path]];
    return out;
  }

  function lineActions(i: number, r: number): MaybeEntry[] {
    const f = files[i];
    const rows = contents[i];
    const ci = rows.ci[r];
    const mine = changesIn(rows, r, r);
    const count = Object.values(sel).reduce((n, s) => n + s.size, 0);
    const many = ci >= 0 && pickedOf(f.path, rows, r) === 2 && count > mine.length;
    let block: number[] = [];
    if (ci >= 0) {
      const [a, b] = blockAt(rows, r);
      block = changesIn(rows, a, b);
    }
    const kind = rows.kind[r];
    return [
      ...(changeActions && ci >= 0 ? changeActions(f, mine, block) : []),
      commentEntry(i, r),
      canEdit(i, r) && { label: 'Edit line', icon: PencilSimpleRegular, note: 'Or double-click it', run: () => startEdit(i, r) },
      !!onremove && !readonly && ci >= 0 && f.partial && {
        label: many
          ? `Remove ${count} picked changes from commit`
          : kind === ADDED
            ? "Don't add this line"
            : kind === SPACED
              ? "Keep this line's old whitespace"
              : 'Keep this removed line',
        icon: EraserRegular,
        note: 'Takes the change out of the commit',
        run: () => onremove!(many ? picked() : { [f.path]: mine }),
      },
    ];
  }

  // Context menus (right-click a file header, a line, or a file or folder in the tree): open in Zed, copy paths.
  /** New-side line number to open at for row r: its own, or the nearest one after/before it. */
  function lineFor(rows: FileRows, r: number): number | undefined {
    for (let k = r; k < rows.n.length && !isHead(rows.kind[k]); k++) if (rows.n[k]) return rows.n[k];
    for (let k = r; k >= 0 && !isHead(rows.kind[k]); k--) if (rows.n[k]) return rows.n[k];
  }

  function firstChange(i: number): number | undefined {
    const rows = contents[i];
    if (!rows) return;
    const r = rows.ci.findIndex((c) => c >= 0);
    return r < 0 ? undefined : lineFor(rows, r);
  }

  /** Open file i in Zed at its first change (double-clicking its name). */
  function openFile(i: number) {
    if (files[i].status !== 'D') app.openInZed(files[i].path, firstChange(i));
  }

  /** GitHub links and issues for row r's line, or for the file's picked lines when r is one of them. */
  function githubEntries(i: number, r: number): MaybeEntry[] {
    const f = files[i];
    const rows = contents[i];
    if (f.status === 'D') return [];
    const s = sel[f.path];
    const lines = [lineFor(rows, r) ?? 0];
    if (rows.ci[r] >= 0 && pickedOf(f.path, rows, r) > 0) {
      for (let k = 0; k < rows.ci.length; k++) if (s.has(rows.ci[k]) || s.has(rows.c2[k])) lines.push(lineFor(rows, k) ?? 0);
    }
    return lineEntries(summary.sha, f.path, lines);
  }

  function openMenu(e: MouseEvent, i: number) {
    // The line being edited (and a review thread) keeps the field's own menu (paste...).
    if ((e.target as HTMLElement).closest('.editor, .gh-slot')) return;
    e.preventDefault();
    const r = rowOf(e);
    const rows = contents[i];
    const onLine = !!rows && r >= 0 && !isHead(rows.kind[r]);
    const line = onLine ? lineFor(rows, r) : firstChange(i);
    const f = files[i];
    menu.show(e, [
      ...(onLine ? [...lineActions(i, r), 'separator' as const] : []),
      {
        label: 'Open in Zed',
        icon: FileArrowUpRegular,
        disabled: f.status === 'D',
        note: line ? `At line ${line}` : undefined,
        run: () => app.openInZed(f.path, line),
      },
      !!renderSide(f) && {
        label: rendered[i] ? 'Show diff' : 'Show rendered',
        icon: rendered[i] ? CodeRegular : EyeRegular,
        run: () => setRendered(i, !rendered[i]),
      },
      'separator',
      { label: 'Copy path', icon: CopyRegular, run: () => app.copy(`${app.repo?.root}/${f.path}`, 'path') },
      { label: 'Copy relative path', icon: CopyRegular, run: () => app.copy(f.path, 'relative path') },
      ...(onLine ? githubEntries(i, r) : []),
      ...(fileActions ? ['separator' as const, ...fileActions(f)] : []),
    ]);
  }

  function openDirMenu(e: MouseEvent, dir: string) {
    const inside = files.filter((f) => f.path.startsWith(dir + '/'));
    menu.show(e, [
      {
        label: 'Open in Zed',
        icon: FolderOpenRegular,
        // Every file in it deleted: the folder is most likely gone too.
        disabled: inside.every((f) => f.status === 'D'),
        run: () => app.openInZed(dir),
      },
      'separator',
      { label: 'Copy path', icon: CopyRegular, run: () => app.copy(`${app.repo?.root}/${dir}`, 'path') },
      { label: 'Copy relative path', icon: CopyRegular, run: () => app.copy(dir, 'relative path') },
      ...(folderActions ? ['separator' as const, ...folderActions(dir, inside)] : []),
    ]);
  }

  // Conflict markers (in the conflict view): the sides named as their markers name them, e.g. HEAD and feature.
  const OPENS = /^<{7}(?: |$)/;
  const sideName = (marker: string, or: string) => marker.slice(8).trim() || or;
  function sides(rows: FileRows, r: number): { ours: string; theirs: string } | null {
    for (let k = r + 1; k < rows.text.length && !isHead(rows.kind[k]); k++) {
      if (OPENS.test(rows.text[k])) return null;
      if (/^>{7}(?: |$)/.test(rows.text[k])) return { ours: sideName(rows.text[r], 'ours'), theirs: sideName(rows.text[k], 'theirs') };
    }
    return null;
  }

  /** "12.3 KB → 14.1 KB", or the one side there is. */
  function sizes(f: FileSummary): string {
    const [a, b] = [f.oldSize, f.newSize].map((n) => (n === undefined ? null : formatSize(n)));
    return a && b ? `${a} → ${b}` : b ? `added, ${b}` : a ? `deleted, ${a}` : '';
  }

  const imageUrl = (i: number, side: 'old' | 'new') => `/api/diff/${summary.sha}/image?i=${i}&side=${side}`;

  const statusLabel = { A: 'added', D: 'deleted', M: '', T: 'type changed', R: 'renamed', C: 'copied' };
  const statusColor = { A: 'var(--add)', D: 'var(--del)', M: undefined, T: undefined, R: undefined, C: undefined };
  const MARK = [' ', ' ', '+', '-', ' ', '~'];
  const KIND = ['', 'tc', 'ta', 'td', '', 'tw'];
</script>

<svelte:window onmouseup={up} />

<div class="diff" style:--inset="{inset}px">
  <span class="measure mono" aria-hidden="true" {@attach measureChars}>{'0'.repeat(100)}</span>
  <div class="panes" class:with-tree={showTree} style:--tree-width="{treeWidth}px" style:--side-height="{sideHeight}px">
    <!-- Never taller than what's on screen of the diff (see sideHeight), so its ends can always be reached. -->
    <div class="side">
      <div class="summary muted" bind:clientHeight={summaryHeight}>
        <div class="stats">
          <div class="line">
            <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            <span class="add">+{totals.a}</span>
            <span class="del">−{totals.r}</span>
            {#if generatedCount}
              <span use:tooltip={'Generated files start collapsed'}>· {generatedCount} generated</span>
            {/if}
          </div>
          <div class="line">
            <label class="ws" use:tooltip={'Show lines whose only change is whitespace as unchanged (~); picking one still picks both its changes'}>
              <Switch label="Hide whitespace changes" bind:checked={hideWhitespace.value} />
              Hide whitespace
            </label>
            {#if hideWhitespace.value && totals.ws}
              <span>· {totals.ws} whitespace-only</span>
            {/if}
          </div>
        </div>
      </div>
      {#if showTree}
        <nav class="tree">
          <FileTree {files} {current} onpick={reveal} onopen={openFile} onmenu={openMenu} ondirmenu={openDirMenu} bind:natural={treeNatural} />
        </nav>
        <ResizeEdge
          side="left"
          label="Resize the file tree"
          size={treeWidth}
          min={140}
          max={600}
          preset={TREE_WIDTH}
          onresize={(w) => (treeWidth = w)}
          oncommit={(w) => (savedTreeWidth.value = w)}
        />
      {/if}
    </div>
    <div class="files" bind:this={filesEl} style:height="{Math.max(0, tops[files.length] - GAP)}px">
      {#each visible as i (i)}
        {@const f = files[i]}
        {@const state = fileState(f)}
        {@const rows = contents[i]}
        {@const tok = tokens[i]}
        {@const fileHits = hits.get(i)}
        <div class="file" style:top="{tops[i]}px" style:height="{fileHeight(i)}px">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fhead" oncontextmenu={(e) => openMenu(e, i)}>
            {#if !readonly}
              <input
                type="checkbox"
                class="checkbox"
                checked={state === 'all'}
                indeterminate={state === 'some'}
                onchange={() => toggleFile(f)}
                use:tooltip={onstage ? (state === 'all' ? 'Unstage the whole file' : 'Stage the whole file') : 'Pick the whole file'}
              />
            {/if}
            <button
              class="btn btn--ghost btn--icon btn--sm"
              aria-label={collapsed[i] ? 'Expand' : 'Collapse'}
              aria-expanded={!collapsed[i]}
              onclick={() => toggleCollapsed(i)}
            >
              <Twisty open={!collapsed[i]} size={10} />
            </button>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              class="path mono"
              use:tooltip={(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path) + (f.status === 'D' ? '' : '\nDouble-click to open in Zed')}
              ondblclick={() => openFile(i)}
              >{#if f.oldPath}<span class="old">{f.oldPath}</span> <span class="muted">→</span>{' '}{/if}{f.path}</span
            >
            {#if f.untracked}<Tag color="var(--add)" label="untracked" />
            {:else if statusLabel[f.status]}<Tag color={statusColor[f.status]} label={statusLabel[f.status]} />{/if}
            {#if onstage && (f.unshown || mixed.has(f.path))}
              <span
                use:tooltip={f.unshown ??
                  "Changed again after staging, so what's staged is neither version. Pick a line to stage the new version of its block, or unpick it."}
                ><Tag color="var(--warn)" label="staged differently" /></span
              >
            {/if}
            {#if f.generated}
              <span use:tooltip={'Collapsed by default; the README says how to change which files'}><Tag label="generated" /></span>
            {/if}
            {#if hideWhitespace.value && onlyWhitespace(f)}
              <span use:tooltip={'Every change here is whitespace only'}><Tag label="whitespace only" /></span>
            {/if}
            {#if placedThreads[i]?.elsewhere.length}
              {@const n = placedThreads[i].elsewhere.length}
              <span
                class="away"
                data-away={i}
                use:tooltip={"Review threads on this file, made on this commit, that aren't on a line of its diff: on the whole file, or outdated"}
              >
                <Tag
                  color="var(--theme2)"
                  label="{n} {n === 1 ? 'comment' : 'comments'} off the diff"
                  onclick={(e) => (away = { i, el: e.currentTarget as HTMLElement })}
                />
              </span>
            {/if}
            {#if rendered[i] && placedThreads[i]?.blocks.length}
              {@const n = placedThreads[i].blocks.length}
              <span use:tooltip={'Review threads on lines of this file show with its diff'}>
                <Tag
                  color="var(--theme2)"
                  label="{n} {n === 1 ? 'thread' : 'threads'} in the diff"
                  onclick={() => setRendered(i, false)}
                />
              </span>
            {/if}
            <span class="spacer"></span>
            {#if renderSide(f)}
              <IconButton
                size="sm"
                label="Show rendered"
                pressed={!!rendered[i]}
                tip={rendered[i] ? 'Show diff' : 'Show rendered'}
                onclick={() => setRendered(i, !rendered[i])}
                onpointerenter={() => warmRendered(i)}
                onfocus={() => warmRendered(i)}
              >
                {#if rendered[i]}<CodeRegular />{:else}<EyeRegular />{/if}
              </IconButton>
            {/if}
            <span class="add mono">+{f.added}</span>
            <span class="del mono">−{f.removed}</span>
          </div>

          {#if !collapsed[i] && rendered[i]}
            {@const page = renderedView(i, rows)}
            <div class="body page" style:height="{bodyHeight(i)}px">
              {#if page === undefined}
                <div class="note status">Loading…</div>
              {:else}
                <div {@attach measureRendered(i)} {@attach renderedBody(i)}>
                  {#if 'text' in page}
                    {@const { text, table, changed, old } = page}
                    <RenderedFile
                      kind={renderKind(f.path)!}
                      path={f.path}
                      {text}
                      {table}
                      {changed}
                      {old}
                      fold={(folds[i] ??= { opened: [] })}
                      removed={f.status === 'D'}
                    />
                  {:else}
                    <div class="note status">{page.error}</div>
                  {/if}
                </div>
              {/if}
            </div>
          {:else if !collapsed[i]}
            {#if lead(i)}
              {@const kind = f.path.slice(f.path.lastIndexOf('.') + 1).toUpperCase()}
              <ImageDiff
                before={f.status === 'A' ? null : imageUrl(i, 'old')}
                after={f.status === 'D' ? null : imageUrl(i, 'new')}
                note={sizes(f) ? `${kind} · ${sizes(f)}` : kind}
                height={IMG}
                last={!f.rows}
              />
            {/if}
            {#if !f.rows && !lead(i)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="note" class:sel={state === 'all'} onclick={() => toggleFile(f)}>
                {onstage && f.unshown
                  ? f.unshown
                  : f.oldPath && f.oldSha === f.newSha && f.oldMode === f.newMode
                  ? `${statusLabel[f.status][0].toUpperCase()}${statusLabel[f.status].slice(1)}, no changes`
                  : f.binary ? `Binary file${sizes(f) ? ` · ${sizes(f)}` : ''}`
                  : f.oldMode === f.newMode ? 'Empty file' : `Mode ${f.oldMode} → ${f.newMode}`}
              </div>
            {:else if f.rows}
              <div class="body" class:loading={!rows} style:height="{linesHeight(i)}px">
                {#if rows}
                  {@const shown = rowRange(i)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="lines mono"
                    class:readonly
                    class:wrap={cols > 0}
                    style:--cols={cols}
                    style:top="{rowY(i, shown[0] ?? 0)}px"
                    style:min-width="max(100%, calc({GUTTER + 20}px + {cols ? Math.min(cols, f.width) : f.width}ch))"
                    onmousedown={(e) => down(e, i)}
                    onmouseover={(e) => over(e, i)}
                    onpointerover={(e) => lineTip(e, i)}
                    onmouseleave={() => (hoverBlock = null)}
                    ondblclick={(e) => startEdit(i, rowOf(e))}
                    oncontextmenu={(e) => openMenu(e, i)}
                    onfocus={() => {}}
                  >
                    {#each app.display.guides as col (col)}
                      <span class="guide" style:left="calc({GUTTER + 8}px + {col}ch)"></span>
                    {/each}
                    {#each shown as r (r)}
                      {#if isHead(rows.kind[r])}
                        {@const k = rows.gap[r]}
                        {@const left = k >= 0 ? rows.hidden[k] : 0}
                        {@const tail = rows.kind[r] === TAIL}
                        <div class="hunk" class:tail data-r={r}>
                          <span class="gutter xp"
                            >{#if left === null || (left > STEP && tail)}<button
                                use:tooltip={`Show ${STEP} more lines`}
                                aria-label="Show {STEP} more lines"
                                disabled={opening[i]}
                                onclick={() => expand(i, k, 'top')}><ArrowLineDownRegular size={12} /></button
                              >{:else if left > STEP}{#if k > 0}<button
                                  use:tooltip={`Show ${STEP} more lines below the hunk above`}
                                  aria-label="Show {STEP} more lines below the hunk above"
                                  disabled={opening[i]}
                                  onclick={() => expand(i, k, 'top')}><ArrowLineDownRegular size={12} /></button
                                >{/if}<button
                                use:tooltip={`Show ${STEP} more lines above`}
                                aria-label="Show {STEP} more lines above"
                                disabled={opening[i]}
                                onclick={() => expand(i, k, 'bottom')}><ArrowLineUpRegular size={12} /></button
                              >{:else if left > 0}<button
                                use:tooltip={`Show ${left} hidden ${left === 1 ? 'line' : 'lines'}`}
                                aria-label="Show {left} hidden {left === 1 ? 'line' : 'lines'}"
                                disabled={opening[i]}
                                onclick={() => expand(i, k, 'top')}><ArrowsOutLineVerticalRegular size={12} /></button
                              >{/if}</span
                          ><span class="code">{tail ? (left === null ? 'More lines below' : `${left} more ${left === 1 ? 'line' : 'lines'}`) : rows.text[r]}</span>
                        </div>
                      {:else}
                        {@const kind = rows.kind[r]}
                        {@const ci = rows.ci[r]}
                        {@const edit = editing?.i === i && editing.r === r ? editing : null}
                        {@const pick = ci >= 0 ? pickedOf(f.path, rows, r) : 0}
                        <div
                          class="line {KIND[kind]}"
                          class:sel={pick === 2}
                          class:mixed={pick === 1 || (ci >= 0 && mixedAt(f.path, rows, r))}
                          class:blkhover={hoverBlock?.i === i && r >= hoverBlock.a && r <= hoverBlock.b}
                          class:editing={edit}
                          class:gh-range={blockLayout[i]?.on.has(r)}
                          style:height={edit || cols ? `${rowSpan(i, r) * ROW}px` : undefined}
                          data-r={r}
                        >
                          <span class="gutter"
                            ><span class="blk"></span><span>{rows.o[r] || ''}</span><span>{rows.n[r] || ''}</span><span class="mark"
                              >{MARK[kind]}</span
                            ></span
                          >{#if edit}<span class="code"
                              ><textarea
                                class="editor"
                                aria-label="Line {rows.n[r]}"
                                wrap={cols ? 'soft' : 'off'}
                                spellcheck="false"
                                readonly={saving}
                                bind:value={edit.text}
                                onkeydown={editorKey}
                                onblur={closeUnchanged}
                                {@attach attachEditor}
                              ></textarea></span
                            >{:else}<span class="code" {@attach code(i, r, rows, tok, fileHits?.get(r))}></span>{/if}{#if onresolve && kind !== REMOVED && rows.n[r] && OPENS.test(rows.text[r])}
                            {@const s = sides(rows, r)}
                            {#if s}
                              {@const at = rows.n[r]}
                              <span class="resolve" role="group" aria-label="Resolve this conflict"
                                ><button use:tooltip={`Keep what's above =======, from ${s.ours}`} onclick={() => onresolve(f.path, at, 'ours')}
                                  >Keep {s.ours}</button
                                ><button use:tooltip={`Keep what's below =======, from ${s.theirs}`} onclick={() => onresolve(f.path, at, 'theirs')}
                                  >Keep {s.theirs}</button
                                ><button use:tooltip={`Keep both: ${s.ours}'s, then ${s.theirs}'s`} onclick={() => onresolve(f.path, at, 'both')}>Keep both</button
                              ></span>
                            {/if}
                          {/if}
                        </div>
                      {/if}
                      {#each blockLayout[i]?.byRow.get(r) ?? [] as b (b.key)}
                        <div class="gh-slot" style:height="{blockHeight(b)}px" style:width="{paneWidth}px">
                          <div {@attach measureBlock(b)}>
                            {#if b.thread && review?.data}
                              <Thread number={review.data.number} thread={b.thread} moved={b.moved} pending={!!review.data.pending} />
                            {:else if b.draft && review}
                              <Composer {review} draft={b.draft} />
                            {/if}
                          </div>
                        </div>
                      {/each}
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

{#if away && review?.data}
  <Popover
    anchor={away.el}
    label="Review threads not on a line"
    onclose={() => (away = null)}
    width="min(600px, calc(100vw - 32px))"
    maxHeight="70vh"
    padding="var(--sp-4)"
  >
    <div class="away-list">
      {#each placedThreads[away.i]?.elsewhere ?? [] as t (t.id)}
        <Thread number={review.data.number} thread={t} pending={!!review.data.pending} hunk />
      {/each}
    </div>
  </Popover>
{/if}

<style>
  .diff {
    padding: var(--sp-4) var(--sp-5) calc(var(--sp-5) + var(--sp-4));
    container-type: inline-size;
  }

  .panes.with-tree {
    display: grid;
    grid-template-columns: var(--tree-width) minmax(0, 1fr);
    gap: var(--sp-4);
    align-items: start;
  }

  .panes.with-tree .side {
    position: sticky;
    top: var(--inset);
    height: var(--side-height);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tree {
    flex: 1;
    min-height: 0;
    margin-left: calc(-1 * var(--gap-3));
  }

  /* Too narrow for both: the diff keeps the room, the summary goes above it. */
  @container (max-width: 640px) {
    .panes.with-tree {
      display: block;
    }

    .panes.with-tree .side {
      position: static;
      height: auto;
    }

    .tree,
    .side > :global(.edge) {
      display: none;
    }
  }

  .summary {
    display: flex;
    gap: var(--sp-4);
    align-items: center;
    font-size: var(--fs-sm);
    padding: 0 var(--gap-2) var(--sp-4);
  }

  .stats {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .stats .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
    align-items: center;
    white-space: nowrap;
  }

  .ws {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    cursor: pointer;
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }

  .files {
    position: relative;
  }

  .file {
    position: absolute;
    left: 0;
    right: 0;
    border-radius: var(--radius);
    box-shadow: var(--box-shadow);
    background: var(--bg2);
    contain: layout style;
  }

  .fhead {
    position: sticky;
    top: var(--inset);
    z-index: var(--z-sticky);
    height: 34px;
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: 0 var(--sp-4);
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    font-size: var(--fs-sm);
  }

  .path {
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path .old {
    color: var(--muted);
  }

  .spacer {
    flex: 1;
  }

  .note {
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 var(--sp-5);
    color: var(--muted);
    cursor: pointer;
  }

  .note.status {
    cursor: default;
  }

  .note.sel {
    background: var(--theme-soft);
    color: var(--theme2);
  }

  .body {
    position: relative;
    background: var(--code-bg);
    border-radius: 0 0 var(--radius) var(--radius);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    contain: strict;
  }

  /* A rendered file scrolls sideways within itself (a wide table), if at all. */
  .body.page {
    background: var(--surface);
    overflow: hidden;
  }

  .body::-webkit-scrollbar {
    display: none;
  }

  /* Placeholder until the file's contents arrive: faint line stripes. */
  .body.loading {
    background: repeating-linear-gradient(
      to bottom,
      transparent 0 5px,
      var(--bg3) 5px 12px,
      transparent 12px 19px
    );
    background-size: 60% 19px;
    background-repeat: repeat-y;
    background-position: 120px 0;
    opacity: 0.6;
  }

  .measure {
    position: absolute;
    visibility: hidden;
    font-size: var(--fs-sm);
    white-space: pre;
  }

  .lines {
    position: absolute;
    left: 0;
    width: max-content;
    font-size: var(--fs-sm);
    line-height: 19px;
    color: var(--color);
  }

  .line,
  .hunk {
    display: flex;
    height: 19px;
    white-space: pre;
    tab-size: 4;
  }

  .gutter {
    position: sticky;
    z-index: 1;
    left: 0;
    display: flex;
    flex-shrink: 0;
    width: 90px;
    background: var(--code-bg);
    color: var(--muted);
    user-select: none;
    font-size: var(--fs-xs);
    box-shadow: inset -1px 0 0 var(--border);
  }

  /* A guide column, under the gutter when scrolled sideways. */
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border-strong);
    pointer-events: none;
  }

  /* Four digits wide. */
  .gutter > span {
    width: 32px;
    text-align: right;
    padding-right: 4px;
  }

  .gutter > .mark {
    width: 12px;
    text-align: center;
    padding: 0;
  }

  /* Wide enough to hit; it only shows a thin bar until hovered. */
  .gutter > .blk {
    width: 14px;
    padding: 0;
  }

  .lines:not(.readonly) :is(.ta, .td, .tw) .blk {
    cursor: pointer;
    box-shadow: inset 3px 0 0 transparent;
    transition: box-shadow var(--dur);
  }

  .lines:not(.readonly) :is(.ta, .td, .tw) .blk:hover,
  .lines:not(.readonly) .line.blkhover .blk {
    box-shadow: inset 5px 0 0 var(--theme2);
  }

  .line.blkhover .gutter {
    background: var(--theme-soft);
  }

  .line.sel.blkhover .gutter {
    background: var(--theme);
  }

  .code {
    padding: 0 12px 0 8px;
    flex: 1;
  }

  /* A conflict's choices, on its <<<<<<< line, kept in view when the line scrolls sideways. */
  .resolve {
    position: sticky;
    right: 0;
    flex-shrink: 0;
    align-self: flex-start;
    display: flex;
    gap: var(--gap-2);
    height: 19px;
    align-items: center;
    padding: 0 var(--gap-3);
  }

  .resolve button {
    all: unset;
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 var(--gap-3);
    line-height: 15px;
    border-radius: var(--radius);
    font-family: var(--font);
    font-size: var(--fs-xs);
    color: var(--color2);
    background: var(--surface);
    box-shadow: var(--box-shadow);
    cursor: default;
  }

  .resolve button:focus-visible {
    outline: 2px solid var(--theme2);
  }

  @media (hover: hover) {
    .resolve button:hover {
      background: var(--theme-soft);
    }
  }

  /* Wrapping: the code breaks anywhere at --cols columns, so each line's rows are known. */
  .lines.wrap .line .code {
    flex: none;
    box-sizing: content-box;
    width: calc(var(--cols) * 1ch);
    white-space: break-spaces;
    word-break: break-all;
  }

  .lines.wrap .line.editing .code {
    padding: 0 12px 0 8px;
  }

  .lines.wrap .hunk .code {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hunk {
    color: var(--muted);
    background: var(--bg3);
    cursor: pointer;
    font-size: var(--fs-xs);
  }

  .hunk:hover .code {
    color: var(--theme2);
  }

  .readonly .hunk:not(.tail) {
    cursor: default;
  }

  /* A gap's arrows, in its header's gutter. */
  .xp {
    justify-content: center;
    align-items: center;
    gap: 2px;
  }

  .xp button {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 17px;
    border-radius: var(--radius);
    color: var(--muted);
    cursor: pointer;
  }

  .xp button:hover {
    color: var(--theme2);
    background: var(--theme-soft);
  }

  .xp button:focus-visible {
    outline: 2px solid var(--theme2);
    outline-offset: -2px;
  }

  .xp button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ta {
    background: var(--add-bg);
  }

  .td {
    background: var(--del-bg);
  }

  .ta .gutter {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--code-bg);
  }

  .td .gutter {
    background: linear-gradient(var(--del-bg), var(--del-bg)), var(--code-bg);
  }

  .ta .mark {
    color: var(--add);
  }

  .td .mark {
    color: var(--del);
  }

  .lines:not(.readonly) :is(.ta, .td, .tw) .gutter {
    cursor: pointer;
  }

  .tw .mark {
    color: var(--muted);
  }

  /* Text that isn't the file's stays out of a copy. */
  .hunk .code,
  .code :global(.eof) {
    user-select: none;
  }

  .lines:not(.readonly) .ta:not(.sel):hover .gutter,
  .lines:not(.readonly) .td:not(.sel):hover .gutter,
  .lines:not(.readonly) .tw:not(.sel):hover .gutter {
    background: var(--theme-soft);
  }

  .line.sel .gutter {
    background: var(--theme);
    color: var(--on-accent);
  }

  .line.sel .gutter .mark {
    color: var(--on-accent);
  }

  /* Staged in a version that's neither side's: half picked. */
  .line.mixed .gutter {
    background: repeating-linear-gradient(135deg, var(--theme-mid) 0 3px, transparent 3px 6px), var(--code-bg);
  }

  .line.ta.sel {
    background: var(--add-sel);
  }

  .line.td.sel {
    background: var(--del-sel);
  }

  .line.tw.sel {
    background: var(--theme-soft);
  }

  .line.sel .code {
    box-shadow: inset 2px 0 0 var(--theme2);
  }

  /* A line being edited: the field covers the code column, a row per line it has. */
  .line.editing .code {
    position: relative;
    padding: 0;
  }

  .editor {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    padding: 0 12px 0 8px;
    border: none;
    border-radius: 0;
    resize: none;
    overflow: hidden;
    box-sizing: border-box;
    font: inherit;
    line-height: 19px;
    white-space: pre;
    tab-size: 4;
    color: var(--color);
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--theme2);
    outline: none;
  }

  .lines.wrap .editor {
    white-space: break-spaces;
    word-break: break-all;
  }

  .editor[readonly] {
    opacity: 0.6;
  }

  /* Words changed within a line: a stronger tint of its own. (A line's runs are built by `code`, outside Svelte.) */
  .ta .code :global(.wd:not(.hit)) {
    background: var(--add-sel);
  }

  .td .code :global(.wd:not(.hit)) {
    background: var(--del-sel);
  }

  .code :global(.hit) {
    border-radius: var(--radius-sm);
    background: var(--theme-mid);
    color: inherit;
  }

  .code :global(.hit.now) {
    background: var(--theme2);
    color: var(--on-accent2);
  }

  .code :global(.eof) {
    color: var(--del);
    opacity: 0.7;
    margin-left: var(--gap-2);
  }

  /* A review thread under its line, as wide as the view however far the lines are scrolled. */
  .gh-slot {
    position: sticky;
    left: 0;
    z-index: 2;
    box-sizing: border-box;
    padding: 6px var(--sp-4) 6px 40px;
    overflow: hidden;
  }

  /* The lines a review thread is about: a bar just inside the code, joined across them. */
  .line.gh-range .code {
    background: linear-gradient(to right, transparent 2px, var(--theme2) 2px 5px, transparent 5px) no-repeat;
  }

  .away {
    display: inline-flex;
  }

  .away-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }
</style>
