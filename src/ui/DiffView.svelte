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
    Button,
    IconButton,
    Kbd,
    Popover,
    ResizeEdge,
    Tag,
    Twisty,
    fixedRange,
    hasOverlay,
    isTyping,
    matches,
    menu,
    offsets,
    persisted,
    rowAt,
    Switch,
    toast,
    tooltip,
    variableRange,
  } from 'purr';
  import { ArrowLineDownRegular, ArrowLineUpRegular, ArrowsOutLineVerticalRegular, ChatCircleTextRegular, CheckSquareRegular, CodeRegular, CopyRegular, EraserRegular, EyeRegular, FileArrowUpRegular, FolderOpenRegular, PencilSimpleRegular, SquareRegular, TextIndentRegular, TrashRegular, XRegular } from 'purr/glyphs';
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
  import Annotation from './gh/Annotation.svelte';
  import type { Annotation as CiNote } from '../shared/gh-files.ts';
  import Composer from './gh/Composer.svelte';
  import FileMarks from './gh/FileMarks.svelte';
  import ReviewProgress from './gh/ReviewProgress.svelte';
  import Thread from './gh/Thread.svelte';
  import { tracking } from './lib/gh-files.svelte.ts';
  import { type Block, type DiffReview, reviews } from './lib/gh-review.svelte.ts';
  import { type BlockLayout, heightAbove, layOut, threadCounts } from './lib/gh-threads.ts';
  import { type DiffPosition, app, hideWhitespace, highlightKey, sideBySide } from './lib/app.svelte.ts';
  import { lineEntries } from './lib/gh-issues.svelte.ts';
  import { type Tokens, highlight, prepare, segments } from './lib/highlighter.ts';
  import { tip } from './lib/tip.ts';
  import { wrappedOffsets, wrappedRows } from './lib/wrap.ts';
  import { caseSensitive, markSegments, matchesIn } from './lib/find.ts';
  import { finder } from './lib/finder.svelte.ts';
  import { cutWords, wordDiff } from './lib/worddiff.ts';
  import { conflictRoles } from './lib/conflicts.ts';
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
    expansionOf,
    gapsOf,
    isHead,
    moveTokens,
    noExpansion,
    rowHunks,
    rowMap,
    rowOfChange,
    rowOfPlace,
    rowPlace,
    rowsIn,
    runAround,
    shownRanges,
  } from './lib/rows.ts';
  import { type Anchor, type Knot, anchorAt, readKnots, rowAnchor, rowOfAnchor, yOf } from './lib/place.ts';
  import { type SideBySide, rowOn, sideBlocks, sideOffsets, sideWords, sideBySide as pairSides } from './lib/side-by-side.ts';

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
    /** Replace `count` lines from line `line` of the commit's version of file `path` with `text` (lines separated by \n; null deletes them). */
    oneditline?: (path: string, line: number, text: string | null, count: number) => Promise<boolean>;
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
  /** The rule between the conflicted files and the rest, in the conflict view. */
  const SEP = 34;

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

  // Editing lines in place (double-click one, or its menu): the row becomes a text field, which
  // grows by a row per line typed into it and pushes the rows below down. ↑ on its first line or
  // ↓ on its last takes in the line next to it (rows r..end, removed lines among them hidden meanwhile).
  let editing = $state<{ i: number; r: number; end: number; text: string; orig: string } | null>(null);
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
  /** Threads and comments on whole files, at the top of their files' lines (as images are). */
  const fileBlocks = $derived.by(() => {
    const out: Record<number, Block[]> = {};
    for (const [path, b] of review?.onFiles ?? []) {
      const i = files.findIndex((f) => f.path === path);
      if (i >= 0) out[i] = b;
    }
    return out;
  });
  const fileBlocksHeight = (i: number) => fileBlocks[i]?.reduce((h, b) => h + blockHeight(b), 0) ?? 0;
  let blockHeights = $state<Record<string, number>>({});
  function blockHeight(b: Block): number {
    const known = blockHeights[b.key] ?? reviews.heights.get(b.key);
    if (known !== undefined) return known;
    if (b.draft) return 190;
    if (b.note) return 44 + 2 * SLOT_PAD + 16 * Math.min(14, b.note.message.split('\n').length);
    const shut = 32 + 2 * SLOT_PAD;
    return reviews.isOpen(b.thread) ? shut + 64 + 90 * b.thread.comments.length : shut;
  }
  const blockLayout = $derived.by(() => {
    const out: Record<number, BlockLayout<Block>> = {};
    for (const [k, v] of Object.entries(placedThreads)) if (v.blocks.length) out[+k] = layOut(v.blocks, blockHeight);
    return out;
  });
  /** The same, under the rows side by side that show their rows. */
  const sideLayout = $derived.by(() => {
    const out: Record<number, BlockLayout<Block>> = {};
    for (const [k, a] of Object.entries(blockLayout)) {
      const s = sbs(+k);
      if (s) out[+k] = layOut(sideBlocks([...a.byRow.values()].flat(), s), blockHeight);
    }
    return out;
  });
  /** File i's blocks, under its rows as they show. */
  const blocksOf = (i: number): BlockLayout<Block> | undefined => (side ? sideLayout[i] : blockLayout[i]);
  /** Height of file i's blocks under the rows before row r. */
  const blocksAbove = (i: number, r: number) => {
    const a = blocksOf(i);
    return a ? heightAbove(a, r) : 0;
  };

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
    const onFile = fileBlocks[i]?.findIndex((x) => x.key === f.id) ?? -1;
    // A thread shows with the diff: a rendered file goes back to it (and this runs again).
    if (rendered[i]) return void untrack(() => setRendered(i, false));
    untrack(() => {
      if (!scroller) return;
      if (onFile >= 0) {
        reviews.focus = null;
        if (collapsed[i]) {
          collapsed[i] = false;
          flushSync();
        }
        const y = tops[i] + HEAD + fileBlocks[i].slice(0, onFile).reduce((h, b) => h + blockHeight(b), 0);
        if (y < view.top + HEAD || y + Math.min(blockHeight(fileBlocks[i][onFile]), (view.bottom - view.top) / 2) > view.bottom) {
          scroller.scrollTop += y - view.top - HEAD;
          measure();
        }
        return;
      }
      if (!placed) return reveal(i);
      reviews.focus = null;
      const b = placed.blocks.find((x) => x.key === f.id);
      if (!b) {
        reveal(i);
        if (placed.elsewhere.some((t) => t.id === f.id)) tick().then(() => openAway(i));
        return;
      }
      const v = vrow(i, b.row);
      const same = blocksOf(i)?.byRow.get(v) ?? [];
      let y = tops[i] + HEAD + lead(i) + rowY(i, v) + rowSpan(i, v) * ROW;
      for (const x of same) {
        if (x.key === b.key) break;
        y += blockHeight(x);
      }
      if (y < view.top + HEAD || y + Math.min(blockHeight(b), (view.bottom - view.top) / 2) > view.bottom) {
        scroller.scrollTop += y - view.top - (view.bottom - view.top) / 4;
        measure();
      }
    });
  });

  // GitHub's Viewed marks, owners and CI annotations, on a diff of the pull request (lib/gh-files.svelte.ts).
  const track = $derived(review?.track ?? null);
  const paths = $derived(files.map((f) => f.path));
  /** Fold a file marked viewed, unfold one unmarked. */
  function foldViewed(i: number, on: boolean) {
    if (!!collapsed[i] !== on) toggleCollapsed(i);
  }
  /** Mark file i viewed or not, folding it; refused, it's as it was. */
  async function setViewed(i: number, on: boolean) {
    const path = files[i].path;
    foldViewed(i, on);
    if (!(await track?.setViewed(path, on)) && alive && files[i]?.path === path) foldViewed(i, !on);
  }
  // In the pull request's whole diff, files marked viewed start folded, as on GitHub, once the marks are in (unless the view
  // this one replaces said otherwise). One commit shows only part of a file's change, so there they stay open.
  let foldedViewed = false;
  $effect(() => {
    const t = track;
    if (!t?.viewable || !t.whole || foldedViewed) return;
    foldedViewed = true;
    untrack(() =>
      files.forEach((f, i) => {
        if (t.viewed(f.path) === 'VIEWED' && !initial?.files?.includes(f.path)) collapsed[i] = true;
      }),
    );
  });
  function viewedEntry(i: number): MaybeEntry {
    const v = track?.viewed(files[i].path);
    if (!track || !v) return false;
    const on = v !== 'VIEWED';
    return { label: on ? 'Mark as viewed' : 'Mark as not viewed', icon: on ? CheckSquareRegular : SquareRegular, note: `On #${track.pr?.number}`, run: () => setViewed(i, on) };
  }
  /** File i's review threads in this diff: how many are unresolved and resolved, and the first. */
  const threadsOf = (i: number) => (review ? threadCounts(review.threadsOn(files[i].path, placedThreads[i]?.blocks)) : null);
  function treeMark(i: number) {
    const p = files[i].path;
    const threads = threadsOf(i);
    return { viewed: track?.viewed(p) === 'VIEWED', mine: !!track?.mine(p), notes: track?.counts(p) ?? null, threads: threads && { open: threads.open, resolved: threads.resolved } };
  }
  /** Bring file i's first thread (its first unresolved one) into view. */
  function showThreads(i: number) {
    const t = threadsOf(i)?.first;
    if (!t) return;
    if (t.resolved) reviews.opened[t.id] = true;
    reviews.focus = { id: t.id, path: t.path };
  }
  // The shortcut toggles Viewed on the file at the top of the view (the first, above them).
  $effect(() => {
    const t = track;
    if (!t) return;
    return tracking.onKey(() => {
      const i = Math.max(0, current);
      if (i >= files.length) return;
      const v = t.viewed(files[i].path);
      if (v) setViewed(i, v !== 'VIEWED');
      else if (t.pr && t.data && review?.data)
        toast(t.viewable ? `${files[i].path} isn't part of #${t.pr.number}.` : `Files are marked viewed in diffs of #${t.pr.number}'s commits, as GitHub has them.`);
    });
  });

  // A file's threads that have no line here, listed from its header.
  let away = $state<{ i: number; el: HTMLElement } | null>(null);
  // Likewise its CI annotations on lines it doesn't show.
  let notesAway = $state<{ i: number; el: HTMLElement } | null>(null);
  const awayNotes = (i: number) => (track && contents[i] ? track.place(files[i].path, contents[i]).elsewhere : []);

  async function showNote(i: number, note: CiNote) {
    notesAway = null;
    if (await showLine(i, note.startLine)) reviews.focus = { id: `note:${note.key}`, path: files[i].path };
    else toast(`Line ${note.startLine} of ${files[i].path} isn't in this diff's version of the file.`);
  }
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
    const p = commenting ? (span?.i === i ? [span.a, span.b] : null) : sel[files[i].path]?.size ? pickedRows(i) : null;
    const [a, b] = Array.isArray(p) && r >= p[0] && r <= p[1] ? p : [r, r];
    const why = review.why(files[i].path, rows, a, b);
    return {
      label: a === b ? 'Comment on this line…' : `Comment on ${b - a + 1} lines…`,
      icon: ChatCircleTextRegular,
      disabled: !!why,
      note: why ?? `On #${review.pr.number}`,
      run: () => review.compose(files[i].path, rows, a, b),
    };
  }

  /** "Comment on this file…", in a file's menu. */
  function fileCommentEntry(i: number): MaybeEntry {
    if (!review?.pr) return false;
    const why = review.fileWhy(files[i].path);
    return { label: 'Comment on this file…', icon: ChatCircleTextRegular, disabled: !!why, note: why ?? `On #${review.pr.number}`, run: () => review.composeFile(files[i].path) };
  }

  /** Commenting on the picked lines, for the view's own buttons: why not, and how; null without a pull request. */
  export function pickedComment(): { why: string | null; run: () => void } | null {
    if (!review?.pr) return null;
    if (commenting) {
      const p = span;
      const rows = p && contents[p.i];
      if (!p || !rows) return null;
      const path = files[p.i].path;
      return {
        why: review.why(path, rows, p.a, p.b),
        run: () => {
          span = null;
          review.compose(path, rows, p.a, p.b);
        },
      };
    }
    const i = files.findIndex((f) => sel[f.path]?.size);
    if (i < 0) return null;
    const p = pickedRows(i);
    if (typeof p === 'string') return { why: p, run: () => {} };
    const why = review.why(files[i].path, contents[i], p[0], p[1]);
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

  // Side by side (the setting, where the diff is wide enough, and not while a line's edited): lib/side-by-side.ts
  // pairs each file's rows, drawn in two columns that scroll sideways apart. The geometry below is then in those
  // rows (v), not the FileRows' (r), which everything else keeps working in: vrow() goes from one to the other.
  const SIDE_GUTTER = 62;
  /** About 22 columns of code a side: narrower, it stays one above the other, and the switch says so. */
  /** A hunk header (`@@ -12,12 +13,14 @@ fn`) as one half of a side-by-side row shows it: that side's lines, and the context. */
  const halfHeader = (text: string, half: 'old' | 'new') => {
    const m = /^@@ -(\S+) \+(\S+) @@ ?(.*)$/.exec(text);
    return m ? `@@ ${half === 'old' ? `-${m[1]}` : `+${m[2]}`} @@ ${m[3]}`.trimEnd() : text;
  };
  const SIDE_MIN = 520;
  const tooNarrow = $derived(sideBySide.value && !onresolve && (paneWidth || knownPaneWidth) < SIDE_MIN);
  const wantSide = $derived(sideBySide.value && !onresolve && !editing && !tooNarrow);
  let side = $state(untrack(() => wantSide));
  const sideCache = new WeakMap<FileRows, SideBySide>();
  /** File i's rows side by side, when they show so. */
  function sbs(i: number): SideBySide | null {
    const rows = contents[i];
    if (!side || !rows) return null;
    let s = sideCache.get(rows);
    if (!s) sideCache.set(rows, (s = pairSides(rows)));
    return s;
  }
  /** The row in view of file i's row r: itself, or the row side by side it's on. */
  function vrow(i: number, r: number): number {
    const s = sbs(i);
    return !s ? r : r < s.at.length ? s.at[r] : s.left.length;
  }
  /** Columns each side wraps at, side by side. */
  const sideCols = $derived.by(() => {
    const { wrap, wrapColumn } = app.display;
    if (wrap === 'none' || !charWidth || !paneWidth) return 0;
    const fit = Math.max(20, Math.floor((paneWidth / 2 - SIDE_GUTTER - 20) / charWidth) - 1);
    return wrap === 'column' ? Math.min(wrapColumn, fit) : fit;
  });

  $effect(() => {
    const want = wantSide;
    if (want !== untrack(() => side)) untrack(() => setSide(want));
  });

  /** Show the files side by side or not, the line at the top of the view staying there. */
  function setSide(on: boolean) {
    const k = held?.k ?? -1;
    const y = k >= 0 ? view.top - tops[k] - HEAD - lead(k) : -1;
    const at = y >= 0 && contents[k] && !rendered[k] && !collapsed[k] && y < linesHeight(k) ? rowAtY(k, y) : null;
    hoverBlock = null;
    side = on;
    tick().then(() => {
      if (!alive || !scroller) return;
      if (!at) return keepHeld();
      scroller.scrollTop += tops[k] + HEAD + lead(k) + yOfRow(k, at.r, at.frac) - view.top;
      measure();
    });
  }

  /** File i's rows (side by side, pairs of them): the summary's count until its contents (and any lines shown between hunks) are in. */
  function rowCount(i: number): number {
    const rows = contents[i];
    if (rows) return sbs(i)?.left.length ?? rows.kind.length;
    const f = files[i];
    return f.rows - (hideWhitespace.value ? f.ws + (side ? f.pairedWs : 0) : side ? f.paired : 0);
  }
  /** Where each of file i's rows starts, in rows, when some of its lines wrap; null when none can. */
  const wrapCache = new WeakMap<FileRows, { cols: number; side: boolean; at: Uint32Array }>();
  function wrapped(i: number): Uint32Array | null {
    const rows = contents[i];
    const c = side ? sideCols : cols;
    if (!c || !rows || files[i].width <= c) return null;
    let w = wrapCache.get(rows);
    if (w?.cols !== c || w.side !== side) wrapCache.set(rows, (w = { cols: c, side, at: side ? sideOffsets(rows, sbs(i)!, c) : wrappedOffsets(rows, c) }));
    return w.at;
  }
  /** Rows of file i's lines a..b take, as they show when not edited. */
  function plainSpan(i: number, a: number, b: number): number {
    const at = wrapped(i);
    return at ? at[b + 1] - at[a] : b - a + 1;
  }
  /** Row r of file i is in the field, after its first row: not shown. */
  const inField = (i: number, r: number) => editing?.i === i && r > editing.r && r <= editing.end;
  /** Rows row r of file i takes (the one being edited: what its field needs). */
  function rowSpan(i: number, r: number): number {
    if (editing?.i === i && editing.r === r) return editRows;
    if (inField(i, r)) return 0;
    return plainSpan(i, r, r);
  }
  /** Y of row r in file i's lines. */
  function rowY(i: number, r: number): number {
    const at = wrapped(i);
    const y = (at ? at[r] : r) * ROW + blocksAbove(i, r);
    if (editing?.i !== i || editing.r >= r) return y;
    return y + (editRows - plainSpan(i, editing.r, Math.min(r - 1, editing.end))) * ROW;
  }
  /** File i's row (of its FileRows) `y` px into its lines, and how far down it; past the end, the count. */
  function rowAtY(i: number, y: number): { r: number; frac: number } {
    const n = rowCount(i);
    const [v] = rowsIn(n, (k) => rowY(i, k), y, y + 1);
    if (v >= n) return { r: contents[i].kind.length, frac: 0 };
    const s = sbs(i);
    return { r: s ? rowOn(s, v) : v, frac: (y - rowY(i, v)) / (rowSpan(i, v) * ROW) };
  }
  /** Y in file i's lines of its row r, `frac` of the way down it. */
  function yOfRow(i: number, r: number, frac = 0): number {
    const v = vrow(i, r);
    return rowY(i, v) + frac * rowSpan(i, v) * ROW;
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
    const drop = () => (placing = restoring = null);
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
    const { r, frac } = rowAtY(i, above - lead(i));
    return rowAnchor(rows, r, frac, renderSide(files[i]) ?? 'new');
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
      y = lead(i) + yOfRow(i, r, frac);
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

  /** Height of each file's images, and of what comes before its lines: its threads on the whole file, then those. */
  const leads = $derived(files.map((f) => (imageType(f.path) && (f.untracked || f.oldSha !== f.newSha) ? IMG : 0)));
  const lead = (i: number) => fileBlocksHeight(i) + leads[i];
  const linesHeight = (i: number) => rowY(i, rowCount(i)) + PAD;
  const bodyHeight = (i: number) =>
    rendered[i] ? fileBlocksHeight(i) + renderedHeight(i) : lead(i) + (files[i].rows ? linesHeight(i) : leads[i] ? 0 : NOTE);
  /** The first file that isn't conflicted, after some that are (they come first): the rule goes above it; else -1. */
  const merged = $derived.by(() => {
    const k = files.findIndex((f) => !f.conflicted);
    return k > 0 ? k : -1;
  });
  const sepAfter = (i: number) => (i === merged - 1 ? SEP : 0);
  /** Under "Files you own", the files the viewer doesn't own are left out of the diff as of the tree. */
  const ownedOnly = $derived(!!track && tracking.ownedOnly && track.ownsAny(paths) > 0);
  const shown = (i: number) => !ownedOnly || !!track?.mine(files[i].path);
  /** tops[i] = y of file i; tops[n] = total height (plus one trailing gap). */
  const tops = $derived(offsets(files.length, (i) => (shown(i) ? HEAD + (collapsed[i] ? 0 : bodyHeight(i)) + GAP + sepAfter(i) : 0)));
  const fileHeight = (i: number) => tops[i + 1] - tops[i] - GAP - sepAfter(i);

  /** [first, end) of the files overlapping the viewport plus overscan; the same array while they stay the same, as they do for most frames of scrolling. */
  let lastRange: [number, number] = [0, 0];
  const range = $derived.by(() => {
    const [a, b] = variableRange(tops, view.top, view.bottom - view.top, OVERSCAN);
    return a === lastRange[0] && b === lastRange[1] ? lastRange : (lastRange = [a, b]);
  });
  const visible = $derived(Array.from({ length: range[1] - range[0] }, (_, k) => range[0] + k));

  const shownRows = new Map<number, number[]>();
  /** File i's rows near the viewport; the same array while they stay the same, as they do for many frames of slow scrolling. */
  function rowRange(i: number): number[] {
    const y = tops[i] + HEAD + lead(i);
    // Rows of varying height are searched for, not listed: this runs for every frame of scrolling.
    const [a, b] =
      blocksOf(i) || wrapped(i)
        ? rowsIn(rowCount(i), (r) => rowY(i, r), view.top - OVERSCAN - y, view.bottom + OVERSCAN - y)
        : fixedRange(rowCount(i), ROW, view.top - OVERSCAN - y, view.bottom - view.top + 2 * OVERSCAN);
    const last = shownRows.get(i);
    if (last && last.length === b - a && (a === b || last[0] === a)) return last;
    const out: number[] = [];
    for (let r = a; r < b; r++) out.push(r);
    shownRows.set(i, out);
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
      if (k >= 0 && initial.row) restoring = { i: k, row: initial.row, until: performance.now() + 3000 };
      for (const [path, ranges] of Object.entries(initial.expanded ?? {})) {
        const i = files.findIndex((f) => f.path === path);
        if (i >= 0 && expandable(files[i]) && files[i].rows) reopen(i, ranges);
      }
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
        if (restoring && want.includes(restoring.i)) restoreRow();
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

  /** Show new line `n` of file i where it's hidden between hunks (all of that gap); false when no gap here has it. */
  async function showLine(i: number, n: number): Promise<boolean> {
    const x = (expansions[i] ??= noExpansion());
    if (!x.file) {
      try {
        x.file = await app.oldLines(summary.sha, i);
      } catch (e) {
        toast.error(e);
        return false;
      }
      if (!alive) return false;
    }
    const rows = build(i, contents[i].hunks);
    for (let r = 0; r < rows.kind.length; r++) {
      const k = rows.gap[r];
      if (!isHead(rows.kind[r]) || k < 0) continue;
      const before = r > 0 && !isHead(rows.kind[r - 1]) ? rows.n[r - 1] : 0;
      const after = r + 1 < rows.kind.length && !isHead(rows.kind[r + 1]) ? rows.n[r + 1] : Infinity;
      if (n <= before || n >= after) continue;
      const left = rows.hidden[k] ?? 0;
      if (!left) return false;
      const s = k === 0 ? 'bottom' : 'top';
      x[s][k] = (x[s][k] ?? 0) + left;
      replaceRows(i, build(i, contents[i].hunks));
      return true;
    }
    return false;
  }

  /** File i shown as `rows` now: lines keep their highlighting (and the line being edited stays so) where they moved to. */
  function replaceRows(i: number, rows: FileRows) {
    const before = contents[i];
    const moved = rowMap(before, rows);
    if (tokens[i]) tokens = { ...tokens, [i]: moveTokens(tokens[i], before, rows, moved) };
    if (editing?.i === i) {
      const to = (from: number) => {
        const n = before.n[from];
        return moved[from] >= 0 ? moved[from] : rows.n.findIndex((m, k) => m === n && !isHead(rows.kind[k]));
      };
      const [r, end] = [to(editing.r), to(editing.end)];
      if (r >= 0 && end >= r) [editing.r, editing.end] = [r, end];
      else editing = null;
    }
    if (span?.i === i) {
      const [a, b, from] = [moved[span.a], moved[span.b], moved[span.from]];
      span = a >= 0 && b >= 0 && from >= 0 ? { i, a, b, from } : null;
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

  // "Files you own" on or off: the file at the top of the view stays there (the next shown, if it's left out).
  $effect(() => {
    void ownedOnly;
    untrack(keepHeld);
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

  // Words changed within a line, worked out as its rows are shown (side by side, against the line beside it).
  const words = new WeakMap<FileRows, (r: number) => number[] | null>();
  const sideWordsOf = new WeakMap<FileRows, (r: number) => number[] | null>();

  /** Row r of file i in runs: highlighted (`c`), changed words (`w`), find's matches (`m`, at `at`); null when it's plain text. */
  function lineSegments(i: number, r: number, rows: FileRows, tok: Tokens | undefined, at: number[] | undefined) {
    const text = rows.text[r];
    const s = sbs(i);
    const cache = s ? sideWordsOf : words;
    let diff = cache.get(rows);
    if (!diff) cache.set(rows, (diff = s ? sideWords(rows, s) : wordDiff(rows)));
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
      if (rows.ci[r] < 0) return null;
      return commenting ? 'Pick this block, to comment on it' : readonly ? null : onstage ? 'Stage or unstage this block' : 'Pick this block';
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
    const y = tops[m.i] + HEAD + lead(m.i) + yOfRow(m.i, m.r);
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
    const expanded: Record<string, [number, number][]> = {};
    for (const [k, x] of Object.entries(expansions)) {
      const ranges = contents[+k] ? shownRanges(contents[+k].gaps, x) : [];
      if (ranges.length) expanded[files[+k].path] = ranges;
    }
    // The row at the top of the view (below the file's sticky header), when it shows lines.
    let row: DiffPosition['row'] = null;
    const rows = at >= 0 && !rendered[at] && !collapsed[at] ? contents[at] : undefined;
    if (rows?.kind.length) {
      const y = view.top - tops[at] - HEAD - lead(at);
      if (y >= 0) {
        const { r, frac } = rowAtY(at, y);
        if (r < rows.kind.length) row = rowPlace(rows, r, frac);
      }
    }
    return {
      path: at >= 0 ? files[at].path : null,
      offset: at >= 0 ? view.top - tops[at] : 0,
      scrollTop: scroller?.scrollTop ?? 0,
      collapsed: files.filter((_, i) => collapsed[i]).map((f) => f.path),
      files: files.map((f) => f.path),
      shown: visible.map((i) => files[i].path),
      row,
      expanded,
    };
  }

  // Opening at a place (another version of this diff): the line that was at the top goes back
  // there once its file's contents (and the gaps that were open) are in, unless the reader moved first.
  let restoring: { i: number; row: NonNullable<DiffPosition['row']>; until: number } | null = null;
  let reopening = 0;
  function restoreRow() {
    const p = restoring;
    if (!p || !scroller || reopening) return;
    if (performance.now() > p.until || collapsed[p.i] || rendered[p.i]) return void (restoring = null);
    const rows = contents[p.i];
    if (!rows) return;
    flushSync();
    const { r, frac } = rowOfPlace(rows, p.row);
    const y = tops[p.i] + HEAD + lead(p.i) + yOfRow(p.i, r, frac);
    if (Math.abs(y - view.top) >= 0.5) {
      scroller.scrollTop += y - view.top;
      measure();
    }
  }

  /** Show the old lines `ranges` of file i between its hunks, as another version of the diff did. */
  async function reopen(i: number, ranges: [number, number][]) {
    reopening++;
    try {
      const [file, res] = await Promise.all([app.oldLines(summary.sha, i), app.fileContents(summary, [i])]);
      if (!alive) return;
      const x = expansionOf(gapsOf(res[i], file), ranges, file);
      if (!x.top.length && !x.bottom.length) return;
      expansions[i] = x;
      if (contents[i]) replaceRows(i, build(i, contents[i].hunks));
    } catch {
      // The gaps just stay closed.
    } finally {
      reopening--;
      if (alive) restoreRow();
    }
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

  // A read-only diff of a pull request's commits picks lines to comment on instead: any rows of one file, a..b
  // (from the one picked first), by a click, a drag or ⇧-click, a block on its strip, or a hunk on its header.
  const commenting = $derived(readonly && !!review?.pr && !onresolve);
  let span = $state<{ i: number; a: number; b: number; from: number } | null>(null);
  let spanning = false;
  const inSpan = (i: number, r: number) => !!span && span.i === i && r >= span.a && r <= span.b;
  const pickSpan = (i: number, from: number, to: number) => (span = { i, from, a: Math.min(from, to), b: Math.max(from, to) });
  /** Pick rows a..b of file i, or unpick them when they're what's picked. */
  function toggleSpan(i: number, a: number, b: number) {
    if (span?.i === i && span.a === a && span.b === b) span = null;
    else span = { i, a, b, from: a };
  }

  function pickDown(e: MouseEvent, i: number, r: number, rows: FileRows | undefined) {
    if (r < 0 || !rows || e.button !== 0) return;
    if (rows.kind[r] === HUNK) {
      let end = r + 1;
      while (end < rows.kind.length && !isHead(rows.kind[end])) end++;
      if (end > r + 1) toggleSpan(i, r + 1, end - 1);
      return;
    }
    if (isHead(rows.kind[r])) return;
    if (e.shiftKey && span?.i === i) {
      e.preventDefault();
      return void pickSpan(i, span.from, r);
    }
    if (rows.ci[r] >= 0 && onStrip(e)) {
      e.preventDefault();
      const [a, b] = blockAt(rows, r);
      return toggleSpan(i, a, b);
    }
    // A drag over the code selects its text, to copy; a plain click picks its line.
    if (!(e.target as HTMLElement).closest('.gutter')) return void (pending = { i, r, x: e.clientX, y: e.clientY });
    e.preventDefault();
    toggleSpan(i, r, r);
    if (span) spanning = true;
  }

  /** Esc lets go of the picked lines (before anything else takes it, as going back to the overview). */
  function pickKey(e: KeyboardEvent) {
    if (!span || e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target as Element) || hasOverlay()) return;
    e.preventDefault();
    e.stopPropagation();
    span = null;
  }

  // The shortcut comments on the picked lines, in whichever mode picks them.
  onMount(() =>
    reviews.onComment(() => {
      const c = pickedComment();
      if (!c) return false;
      if (c.why) toast.error(c.why);
      else c.run();
      return true;
    }),
  );

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
    if (commenting) return pickDown(e, i, r, rows);
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
    spanning = false;
    const p = pending;
    pending = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) return;
    if (commenting) return toggleSpan(p.i, p.r, p.r);
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
    if (spanning && span?.i === i && !isHead(rows.kind[r])) pickSpan(i, span.from, r);
    // Preview the block the strip would toggle.
    const strip = (!readonly || commenting) && ci >= 0 && onStrip(e);
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

  /** Focus the field when it's first shown (with the caret at `caret`, else at the end), not each time scrolling mounts it again. */
  let focusEditor = false;
  let caret: [number, number, 'forward' | 'backward' | 'none'] | null = null;

  // The line ending isn't part of the text (the server keeps the file's).
  const lineText = (i: number, r: number) => contents[i].text[r].replace(/\r$/, '');

  function startEdit(i: number, r: number) {
    if (saving || !canEdit(i, r)) return;
    if (side) setSide(false);
    const text = lineText(i, r);
    editing = { i, r, end: r, text, orig: text };
    focusEditor = true;
    caret = null;
  }

  /** Edit row r with a new line after it, indented as it is, the caret on that one. */
  function insertBelow(i: number, r: number) {
    if (saving || !canEdit(i, r)) return;
    if (side) setSide(false);
    const orig = lineText(i, r);
    const text = `${orig}\n${/^[ \t]*/.exec(orig)![0]}`;
    editing = { i, r, end: r, text, orig };
    focusEditor = true;
    caret = [text.length, text.length, 'none'];
  }

  /** Take row r's line out of the commit's version of the file. */
  async function deleteLine(i: number, r: number) {
    if (saving || !canEdit(i, r) || !oneditline) return;
    saving = true;
    try {
      await oneditline(files[i].path, contents[i].n[r], null, 1);
    } finally {
      saving = false;
    }
  }

  /** ⌘↩ in the field: a new line after the caret's, indented as it is. */
  function newLineBelow(el: HTMLTextAreaElement) {
    const v = el.value;
    const at = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
    const start = v.lastIndexOf('\n', at - 1) + 1;
    const end = v.indexOf('\n', at) < 0 ? v.length : v.indexOf('\n', at);
    el.setSelectionRange(end, end);
    // As typed, so ⌘Z takes it back.
    document.execCommand('insertText', false, `\n${/^[ \t]*/.exec(v.slice(start, end))![0]}`);
  }

  /** ⌘⇧K in the field: the lines the selection touches go; all of them deletes them from the file. */
  function deleteFieldLines(el: HTMLTextAreaElement) {
    const ed = editing;
    if (!ed || saving) return;
    const v = el.value;
    const start = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const nl = v.indexOf('\n', Math.max(el.selectionStart, el.selectionEnd - 1));
    if (start === 0 && nl < 0) return void saveEdit(null);
    // The line break before them goes when they're the last ones, else the one after.
    const [a, b] = nl < 0 ? [start - 1, v.length] : [start, nl + 1];
    el.setSelectionRange(a, b);
    document.execCommand('delete');
    const at = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
    el.setSelectionRange(at, at);
  }

  /** The commit's next line after row r of file i (`dir` 1) or before it (-1), when it can be edited; removed lines are passed over. */
  function nextLine(i: number, r: number, dir: 1 | -1): number {
    const rows = contents[i];
    for (let k = r + dir; k >= 0 && k < rows.kind.length; k += dir) {
      if (isHead(rows.kind[k])) return -1;
      if (rows.n[k]) return canEdit(i, k) ? k : -1;
    }
    return -1;
  }

  /** Lines of the commit's version in the field: rows r..end of its file, removed ones aside. */
  const fieldLines = (e: NonNullable<typeof editing>) => {
    let n = 0;
    for (let k = e.r; k <= e.end; k++) if (contents[e.i].n[k]) n++;
    return n;
  };

  /** ↑ on the field's first line or ↓ on its last: take the line beyond it in, the caret going on to it. */
  function extendEdit(e: KeyboardEvent, el: HTMLTextAreaElement): boolean {
    const ed = editing;
    if (!ed || saving) return false;
    const down = e.key === 'ArrowDown';
    const v = el.value;
    const at = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
    if (down ? v.indexOf('\n', at) >= 0 : v.lastIndexOf('\n', at - 1) >= 0) return false;
    const k = nextLine(ed.i, down ? ed.end : ed.r, down ? 1 : -1);
    if (k < 0) return false;
    const line = lineText(ed.i, k);
    const col = at - (v.lastIndexOf('\n', at - 1) + 1);
    const anchor = el.selectionDirection === 'backward' ? el.selectionEnd : el.selectionStart;
    if (down) {
      const to = v.length + 1 + Math.min(col, line.length);
      caret = e.shiftKey ? [anchor, to, 'forward'] : [to, to, 'forward'];
      Object.assign(ed, { end: k, text: `${ed.text}\n${line}`, orig: `${ed.orig}\n${line}` });
    } else {
      const shift = line.length + 1;
      const to = Math.min(col, line.length);
      caret = e.shiftKey ? [to, anchor + shift, 'backward'] : [to, to, 'forward'];
      Object.assign(ed, { r: k, text: `${line}\n${ed.text}`, orig: `${line}\n${ed.orig}` });
    }
    // Taking in a line above moves the field to that row: the new one takes the focus.
    focusEditor = true;
    moving = true;
    tick().then(() => {
      moving = false;
      const field = filesEl?.querySelector<HTMLTextAreaElement>('textarea.editor');
      if (field && caret) {
        field.focus({ preventScroll: true });
        field.setSelectionRange(...caret);
        caret = null;
        focusEditor = false;
      }
    });
    return true;
  }
  let moving = false;

  /** Save the field (`text` null: delete its lines). */
  async function saveEdit(text: string | null = editing?.text ?? null) {
    if (!editing || saving || !oneditline) return;
    const { i, r, orig } = editing;
    if (text === orig) {
      editing = null;
      return;
    }
    saving = true;
    try {
      if (await oneditline(files[i].path, contents[i].n[r], text, fieldLines(editing))) editing = null;
    } finally {
      saving = false;
    }
  }

  function editorKey(e: KeyboardEvent) {
    // The field's keys are its own (Esc mustn't also clear the picked lines, say).
    e.stopPropagation();
    if (e.isComposing) return;
    const el = e.currentTarget as HTMLTextAreaElement;
    if (matches('⌘↩', e)) {
      e.preventDefault();
      if (!saving) newLineBelow(el);
    } else if (matches('⌘⇧K', e)) {
      e.preventDefault();
      deleteFieldLines(el);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = null;
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (extendEdit(e, el)) e.preventDefault();
    }
  }

  // Leaving the field closes it if nothing was typed. (Removing the field blurs it too, but not as it moves up a row.)
  function closeUnchanged() {
    if (editing && editing.text === editing.orig && !saving && !moving) editing = null;
  }

  function attachEditor(el: HTMLTextAreaElement) {
    if (!focusEditor) return;
    focusEditor = false;
    el.focus({ preventScroll: true });
    const [a, b, dir] = caret ?? [el.value.length, el.value.length, 'none'];
    el.setSelectionRange(a, b, dir);
    caret = null;
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
      canEdit(i, r) && {
        label: 'Edit line',
        icon: PencilSimpleRegular,
        note: 'Or double-click it; ↑/↓ take in more lines, ⌘↩ adds one below, ⌘⇧K deletes one',
        run: () => startEdit(i, r),
      },
      canEdit(i, r) && { label: 'Insert line below', icon: TextIndentRegular, run: () => insertBelow(i, r) },
      canEdit(i, r) && { label: 'Delete line', icon: TrashRegular, note: 'From the commit', run: () => deleteLine(i, r) },
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
    if (span && inSpan(i, r)) for (let k = span.a; k <= span.b; k++) lines.push(lineFor(rows, k) ?? 0);
    else if (rows.ci[r] >= 0 && pickedOf(f.path, rows, r) > 0) {
      for (let k = 0; k < rows.ci.length; k++) if (s.has(rows.ci[k]) || s.has(rows.c2[k])) lines.push(lineFor(rows, k) ?? 0);
    }
    // A pull request's diff that isn't one commit's (its Files changed) links to its head, which GitHub has.
    const head = !app.bySha.has(summary.sha) && review?.ctx.head ? review.data?.headSha : null;
    return head ? lineEntries(head, f.path, lines, true) : lineEntries(summary.sha, f.path, lines);
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
      fileCommentEntry(i),
      'separator',
      { label: 'Copy path', icon: CopyRegular, run: () => app.copy(`${app.repo?.root}/${f.path}`, 'path') },
      { label: 'Copy relative path', icon: CopyRegular, run: () => app.copy(f.path, 'relative path') },
      ...(onLine ? githubEntries(i, r) : []),
      viewedEntry(i),
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

  /** Each row's part in a conflict, in the conflict view (see lib/conflicts.ts). */
  const roleCache = new WeakMap<FileRows, Uint8Array>();
  function roleOf(rows: FileRows, r: number): number {
    if (!onresolve) return 0;
    let roles = roleCache.get(rows);
    if (!roles) roleCache.set(rows, (roles = conflictRoles(rows)));
    return roles[r];
  }
  const ROLE = ['', 'cf-mark', 'cf-ours', 'cf-base', 'cf-theirs'];

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

<svelte:window onmouseup={up} onkeydowncapture={pickKey} />

<div class="diff" style:--inset="{inset}px">
  <span class="measure mono" aria-hidden="true" {@attach measureChars}>{'0'.repeat(100)}</span>
  <div class="panes" class:with-tree={showTree} style:--tree-width="{treeWidth}px">
    <!-- Never taller than what's on screen of the diff (see sideHeight), so its ends can always be reached. Its own
         height, not a variable the whole diff inherits: that changes as the view scrolls, and would restyle every line. -->
    <div class="side" style:height={showTree ? `${sideHeight}px` : undefined}>
      <div class="summary muted" bind:clientHeight={summaryHeight}>
        <div class="stats">
          <div class="stat">
            <span>{ownedOnly ? `${files.filter((_, i) => shown(i)).length} of ` : ''}{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            <span class="add">+{totals.a}</span>
            <span class="del">−{totals.r}</span>
            {#if generatedCount}
              <span class="dot" use:tooltip={'Generated files start collapsed'}>{generatedCount} generated</span>
            {/if}
          </div>
          <div class="stat">
            <label class="ws" use:tooltip={'Show lines whose only change is whitespace as unchanged (~); picking one still picks both its changes'}>
              <Switch label="Hide whitespace changes" bind:checked={hideWhitespace.value} />
              Hide whitespace
            </label>
            {#if hideWhitespace.value && totals.ws}
              <span class="dot">{totals.ws} whitespace-only</span>
            {/if}
          </div>
          {#if track}<ReviewProgress {track} {paths} />{/if}
          {#if !onresolve}
            <div class="stat">
              <label
                class="ws"
                use:tooltip={tooNarrow
                  ? 'The diff is too narrow to show side by side, so it shows one above the other: widen the window or narrow the file tree (S)'
                  : sideBySide.value && editing
                    ? 'One above the other while a line is edited (S)'
                    : 'Old lines on the left, new ones on the right (S)'}
              >
                <Switch label="Side by side" bind:checked={sideBySide.value} />
                Side by side
              </label>
              {#if tooNarrow}<span class="dot narrow">too narrow here</span>{/if}
            </div>
          {/if}
        </div>
      </div>
      {#if showTree}
        <nav class="tree">
          <FileTree
            {files}
            {current}
            onpick={reveal}
            onopen={openFile}
            onmenu={openMenu}
            ondirmenu={openDirMenu}
            mark={review ? treeMark : undefined}
            onthreads={showThreads}
            only={ownedOnly ? shown : null}
            bind:natural={treeNatural}
          />
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
      {#if merged > 0}
        <div class="merged muted" style:top="{tops[merged] - SEP}px" role="separator" aria-label="Files without conflicts below">
          <span>Merged</span>
        </div>
      {/if}
      {#each visible.filter(shown) as i (i)}
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
            {#if f.conflicted}<span class="tg" use:tooltip={'Still conflicted: resolve it, then mark it resolved'}><Tag color="var(--warn)" label="conflicted" /></span>{/if}
            {#if f.untracked}<Tag color="var(--add)" label="untracked" />
            {:else if statusLabel[f.status]}<Tag color={statusColor[f.status]} label={statusLabel[f.status]} />{/if}
            {#if onstage && (f.unshown || mixed.has(f.path))}
              <span
                class="tg"
                use:tooltip={f.unshown ??
                  "Changed again after staging, so what's staged is neither version. Pick a line to stage the new version of its block, or unpick it."}
                ><Tag color="var(--warn)" label="staged differently" /></span
              >
            {/if}
            {#if f.generated}
              <span class="tg" use:tooltip={'Collapsed by default; the README says how to change which files'}><Tag label="generated" /></span>
            {/if}
            {#if hideWhitespace.value && onlyWhitespace(f)}
              <span class="tg" use:tooltip={'Every change here is whitespace only'}><Tag label="whitespace only" /></span>
            {/if}
            {#if placedThreads[i]?.elsewhere.length}
              {@const n = placedThreads[i].elsewhere.length}
              <span
                class="away tg"
                data-away={i}
                use:tooltip={"Review threads on this file, made on this commit, that aren't on a line of its diff: outdated, or on lines it doesn't show"}
              >
                <Tag
                  color="var(--theme2)"
                  label="{n} {n === 1 ? 'comment' : 'comments'} off the diff"
                  onclick={(e) => (away = { i, el: e.currentTarget as HTMLElement })}
                />
              </span>
            {/if}
            {#if awayNotes(i).length}
              {@const n = awayNotes(i).length}
              <span class="away tg" use:tooltip={"CI annotations on this file's lines that its diff doesn't show"}>
                <Tag
                  color="var(--warn)"
                  label="{n} {n === 1 ? 'annotation' : 'annotations'} off the diff"
                  onclick={(e) => (notesAway = { i, el: e.currentTarget as HTMLElement })}
                />
              </span>
            {/if}
            {#if rendered[i] && placedThreads[i]?.blocks.some((b) => !b.note)}
              {@const n = placedThreads[i].blocks.filter((b) => !b.note).length}
              <span class="tg" use:tooltip={'Review threads on lines of this file show with its diff'}>
                <Tag
                  color="var(--theme2)"
                  label="{n} {n === 1 ? 'thread' : 'threads'} in the diff"
                  onclick={() => setRendered(i, false)}
                />
              </span>
            {/if}
            <span class="spacer"></span>
            {#if track}<FileMarks {track} path={f.path} {rows} onviewed={(on) => setViewed(i, on)} />{/if}
            {#if review?.pr}
              {@const why = review.fileWhy(f.path)}
              <IconButton size="sm" label="Comment on this file" tip={why ?? `Comment on the whole file, on #${review.pr.number}`} onclick={() => review?.composeFile(f.path)}>
                <ChatCircleTextRegular />
              </IconButton>
            {/if}
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
            {#if fileBlocks[i]}
              <div class="gh-top" style:height="{fileBlocksHeight(i)}px">
                {#each fileBlocks[i] as b (b.key)}{@render ghBlock(b, -1)}{/each}
              </div>
            {/if}
            <div class="body page" style:height="{renderedHeight(i)}px">
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
            {#if fileBlocks[i]}
              <div class="gh-top" style:height="{fileBlocksHeight(i)}px">
                {#each fileBlocks[i] as b (b.key)}{@render ghBlock(b, -1)}{/each}
              </div>
            {/if}
            {#if leads[i]}
              {@const kind = f.path.slice(f.path.lastIndexOf('.') + 1).toUpperCase()}
              <ImageDiff
                before={f.status === 'A' ? null : imageUrl(i, 'old')}
                after={f.status === 'D' ? null : imageUrl(i, 'new')}
                note={sizes(f) ? `${kind} · ${sizes(f)}` : kind}
                height={IMG}
                last={!f.rows}
              />
            {/if}
            {#if !f.rows && !leads[i]}
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
              <div class="body" class:loading={!rows} class:sbs={side} style:height="{linesHeight(i)}px">
                {#if rows && side}
                  {@render sideRows(i, rows, tok, fileHits)}
                {:else if rows}
                  {@const shown = rowRange(i)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="lines mono"
                    class:readonly={readonly && !commenting}
                    class:pickrows={commenting}
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
                        {@render hunkRow(i, rows, r)}
                      {:else if !inField(i, r)}
                        {@const kind = rows.kind[r]}
                        {@const ci = rows.ci[r]}
                        {@const edit = editing?.i === i && editing.r === r ? editing : null}
                        {@const pick = ci >= 0 ? pickedOf(f.path, rows, r) : 0}
                        <div
                          class="line {KIND[kind]} {ROLE[roleOf(rows, r)]}"
                          class:sel={pick === 2 || inSpan(i, r)}
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
                                aria-label={edit.end > r ? `Lines ${rows.n[r]} to ${rows.n[edit.end]}` : `Line ${rows.n[r]}`}
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
                                ><button class="ours" use:tooltip={`Keep what's above =======, from ${s.ours}`} onclick={() => onresolve(f.path, at, 'ours')}
                                  >Keep {s.ours}</button
                                ><button class="theirs" use:tooltip={`Keep what's below =======, from ${s.theirs}`} onclick={() => onresolve(f.path, at, 'theirs')}
                                  >Keep {s.theirs}</button
                                ><button use:tooltip={`Keep both: ${s.ours}'s, then ${s.theirs}'s`} onclick={() => onresolve(f.path, at, 'both')}>Keep both</button
                              ></span>
                            {/if}
                          {/if}
                        </div>
                      {/if}
                      {#each blockLayout[i]?.byRow.get(r) ?? [] as b (b.key)}{@render ghBlock(b, runAround(rows.kind, r, r + 1))}{/each}
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
    {#if span && contents[span.i]}
      {@const c = pickedComment()}
      {@const n = span.b - span.a + 1}
      <div class="pick-at">
        <div class="pickbar" role="toolbar" aria-label="Picked lines">
          <ChatCircleTextRegular />
          <span class="count">{n} {n === 1 ? 'line' : 'lines'} of <span class="mono">{files[span.i].path.slice(files[span.i].path.lastIndexOf('/') + 1)}</span></span>
          {#if c?.why}<span class="why">{c.why}</span>{/if}
          <Button variant="primary" size="sm" disabled={!c || !!c.why} onclick={() => c?.run()} {@attach tip(`Comment on these lines on #${review?.pr?.number}`)}>
            Comment <Kbd hint="c" />
          </Button>
          <IconButton label="Clear selection" shortcut="Esc" size="sm" onclick={() => (span = null)}><XRegular /></IconButton>
        </div>
      </div>
    {/if}
  </div>
</div>

{#snippet hunkRow(i: number, rows: FileRows, r: number, half?: 'old' | 'new')}
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
    ><span class="code">{tail ? (left === null ? 'More lines below' : `${left} more ${left === 1 ? 'line' : 'lines'}`) : half ? halfHeader(rows.text[r], half) : rows.text[r]}</span>
  </div>
{/snippet}

{#snippet blockBody(b: Block)}
  {#if b.thread && review?.data}
    <Thread number={review.data.number} thread={b.thread} moved={b.moved} pending={!!review.data.pending} />
  {:else if b.draft && review}
    <Composer {review} draft={b.draft} />
  {:else if b.note}
    <Annotation note={b.note} />
  {/if}
{/snippet}

<!-- Side by side: each half its own column, scrolling sideways on its own; threads over both, under their row. -->
{#snippet sideRows(i: number, rows: FileRows, tok: Tokens | undefined, fileHits: Map<number, number[]> | undefined)}
  {@const f = files[i]}
  {@const s = sbs(i)!}
  {@const shown = rowRange(i)}
  {@const blocks = sideLayout[i]}
  {#each [s.left, s.right] as half, h (h)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="half"
      class:right={h === 1}
      onmousedown={(e) => down(e, i)}
      onmouseover={(e) => over(e, i)}
      onpointerover={(e) => lineTip(e, i)}
      onmouseleave={() => (hoverBlock = null)}
      ondblclick={(e) => startEdit(i, rowOf(e))}
      oncontextmenu={(e) => openMenu(e, i)}
      onfocus={() => {}}
    >
      <div
        class="lines mono"
        class:readonly={readonly && !commenting}
        class:pickrows={commenting}
        class:wrap={sideCols > 0}
        style:--cols={sideCols}
        style:top="{rowY(i, shown[0] ?? 0)}px"
        style:min-width="max(100%, calc({SIDE_GUTTER + 20}px + {sideCols ? Math.min(sideCols, f.width) : f.width}ch))"
      >
        {#each app.display.guides as col (col)}
          <span class="guide" style:left="calc({SIDE_GUTTER + 8}px + {col}ch)"></span>
        {/each}
        {#each shown as v (v)}
          {@const r = half[v]}
          {@const height = sideCols ? `${rowSpan(i, v) * ROW}px` : undefined}
          {#if r < 0}
            <div class="line filler" style:height></div>
          {:else if isHead(rows.kind[r])}
            {#if h === 0}{@render hunkRow(i, rows, r, 'old')}{:else}<div class="hunk" class:tail={rows.kind[r] === TAIL} data-r={r}>
                <span class="gutter xp"></span><span class="code">{rows.kind[r] === TAIL ? '' : halfHeader(rows.text[r], 'new')}</span>
              </div>{/if}
          {:else}
            {@const kind = rows.kind[r]}
            {@const ci = rows.ci[r]}
            {@const pick = ci >= 0 ? pickedOf(f.path, rows, r) : 0}
            <div
              class="line {KIND[kind]}"
              class:sel={pick === 2 || inSpan(i, r)}
              class:mixed={pick === 1 || (ci >= 0 && mixedAt(f.path, rows, r))}
              class:blkhover={hoverBlock?.i === i && r >= hoverBlock.a && r <= hoverBlock.b}
              class:gh-range={blockLayout[i]?.on.has(r)}
              style:height
              data-r={r}
            >
              <span class="gutter"
                ><span class="blk"></span><span>{(h ? rows.n[r] : rows.o[r]) || ''}</span><span class="mark">{MARK[kind]}</span></span
              ><span class="code" {@attach code(i, r, rows, tok, fileHits?.get(r))}></span>
            </div>
          {/if}
          {#if blocks?.byRow.has(v)}
            {@const run = runAround(rows.kind, r, v + 1 < half.length ? half[v + 1] : -1)}
            <div class:in-add={run === ADDED} class:in-del={run === REMOVED} style:height="{blocksAbove(i, v + 1) - blocksAbove(i, v)}px"></div>
          {/if}
        {/each}
      </div>
    </div>
  {/each}
  {#each shown as v (v)}
    {#each blocks?.byRow.get(v) ?? [] as b, k (b.key)}
      {@const y = rowY(i, v) + rowSpan(i, v) * ROW + (blocks.byRow.get(v) ?? []).slice(0, k).reduce((n, x) => n + blockHeight(x), 0)}
      <div class="gh-slot over" style:top="{y}px" style:height="{blockHeight(b)}px">
        <div {@attach measureBlock(b)}>{@render blockBody(b)}</div>
      </div>
    {/each}
  {/each}
{/snippet}

{#snippet ghBlock(b: Block, run: number)}
  <div class="gh-slot" class:in-add={run === ADDED} class:in-del={run === REMOVED} style:height="{blockHeight(b)}px" style:width="{paneWidth}px">
    <div {@attach measureBlock(b)}>{@render blockBody(b)}</div>
  </div>
{/snippet}

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

{#if notesAway}
  {@const i = notesAway.i}
  <Popover
    anchor={notesAway.el}
    label="CI annotations not on a line shown"
    onclose={() => (notesAway = null)}
    width="min(600px, calc(100vw - 32px))"
    maxHeight="70vh"
    padding="var(--sp-4)"
  >
    <div class="away-list">
      {#each awayNotes(i) as note (note.key)}
        <div class="away-note">
          <Annotation {note} />
          <Button size="sm" variant="ghost" onclick={() => showNote(i, note)}>Show line {note.startLine}</Button>
        </div>
      {/each}
    </div>
  </Popover>
{/if}

<style>
  .away-note {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--gap-2);
  }

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
      height: auto !important;
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

  /* Its items wrap whole; the dot before one that starts a line is clipped off. */
  .stat {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
    align-items: center;
    white-space: nowrap;
    overflow: hidden;
    padding: var(--gap-1);
    margin: calc(-1 * var(--gap-1));
  }

  .dot {
    position: relative;
  }

  .narrow {
    color: var(--warn);
  }

  .dot::before {
    content: '·';
    position: absolute;
    right: 100%;
    width: var(--sp-4);
    text-align: center;
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

  /* Between the conflicted files and the rest. */
  .merged {
    position: absolute;
    left: 0;
    right: 0;
    height: 34px;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .merged::before,
  .merged::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border-strong);
  }

  .merged::before {
    flex: 0 0 var(--sp-4);
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

  /* Squeezed, the path gives way first (to a dozen characters), then the tags; the controls and counts never do. */
  .fhead > :global(*) {
    flex-shrink: 0;
  }

  .fhead > .path {
    flex-shrink: 1000;
    min-width: 12ch;
  }

  .fhead > :is(.tg, :global(.marks)) {
    flex-shrink: 1;
    min-width: 0;
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

  /* Tinted as the side each keeps. */
  .resolve button.ours {
    background: var(--conflict-ours);
  }

  .resolve button.theirs {
    background: var(--conflict-theirs);
  }

  .resolve button:focus-visible {
    outline: 2px solid var(--theme2);
  }

  @media (hover: hover) {
    .resolve button:hover {
      background: var(--theme-soft);
    }

    .resolve button.ours:hover {
      background: color-mix(in oklab, var(--info) 26%, var(--code-bg));
    }

    .resolve button.theirs:hover {
      background: color-mix(in oklab, var(--theme2) 26%, var(--code-bg));
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

  .line.sel:not(.ta, .td, .tw) {
    background: var(--theme-soft);
  }

  .lines.pickrows .gutter {
    cursor: pointer;
  }

  @media (hover: hover) {
    .lines.pickrows .line:not(.sel, .filler):hover .gutter {
      background: var(--theme-soft);
    }
  }

  .line.sel .gutter {
    background: var(--theme);
    color: var(--on-accent);
  }

  .line.sel .gutter .mark {
    color: var(--on-accent);
  }

  /* Staged in a version that's neither side's: half picked. One tile per 19px row, so stripes run on across lines. */
  .line.mixed .gutter {
    background:
      linear-gradient(
          135deg,
          var(--theme-mid) 12.5%,
          transparent 12.5% 25%,
          var(--theme-mid) 25% 37.5%,
          transparent 37.5% 50%,
          var(--theme-mid) 50% 62.5%,
          transparent 62.5% 75%,
          var(--theme-mid) 75% 87.5%,
          transparent 87.5%
        )
        0 0 / 19px 19px,
      var(--code-bg);
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
  .gh-top {
    background: var(--code-bg);
  }

  .gh-slot {
    position: sticky;
    left: 0;
    z-index: 2;
    box-sizing: border-box;
    padding: 6px var(--sp-4) 6px 40px;
    overflow: hidden;
  }

  /* Inside a run of added (or removed) lines, what sits under one keeps their tint, so the run reads as one block. */
  .in-add {
    background: var(--add-bg);
  }

  .in-del {
    background: var(--del-bg);
  }

  /* The lines a review thread is about: the gutter's edge thickens into a bar, joined across them (and staying as the code scrolls). */
  .line.gh-range .gutter {
    box-shadow: inset -3px 0 0 var(--theme2);
  }

  /* Side by side: two columns, each scrolling sideways on its own, threads over both. */
  .body.sbs {
    overflow-x: hidden;
  }

  .half {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 50%;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .half::-webkit-scrollbar {
    display: none;
  }

  .half.right {
    left: 50%;
    box-shadow: inset 1px 0 0 var(--border);
  }

  .half .gutter {
    width: 62px;
  }

  .half .gutter > span:not(.blk, .mark) {
    width: 36px;
  }

  .half.right .gutter {
    box-shadow: inset 1px 0 0 var(--border), inset -1px 0 0 var(--border);
  }

  .half.right .line.gh-range .gutter {
    box-shadow: inset 1px 0 0 var(--border), inset -3px 0 0 var(--theme2);
  }

  .half .hunk:empty {
    cursor: default;
  }

  .line.filler {
    background: var(--bg3);
    opacity: 0.5;
  }

  .gh-slot.over {
    position: absolute;
    left: 0;
    right: 0;
  }

  /* A conflict, in the conflict view: its markers in the warning colour, each side a tint of its own, over a
     change's green; a strip down the gutter joins them. */
  .line.cf-mark {
    background: var(--conflict-mark);
    font-weight: 600;
  }

  .line.cf-ours {
    background: var(--conflict-ours);
  }

  .line.cf-base {
    background: var(--conflict-base);
  }

  .line.cf-theirs {
    background: var(--conflict-theirs);
  }

  .line:is(.cf-mark, .cf-ours, .cf-base, .cf-theirs) .gutter {
    background: inherit;
  }

  .line:is(.cf-mark, .cf-ours, .cf-base, .cf-theirs) .blk {
    box-shadow: inset 4px 0 0 var(--warn);
  }

  .line.cf-mark .mark {
    color: var(--warn);
  }

  .tg {
    display: inline-flex;
    min-width: 0;
  }

  /* Lines picked to comment on, in a read-only diff: what to do with them, below the diff, kept in view over a longer one. */
  .pick-at {
    grid-column: -2 / -1;
    position: sticky;
    bottom: var(--sp-4);
    z-index: calc(var(--z-sticky) + 1);
    display: flex;
    justify-content: center;
    margin-top: var(--sp-4);
    pointer-events: none;
  }

  .pickbar {
    pointer-events: auto;
    max-width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--gap-4) var(--gap-4) var(--gap-4) var(--sp-5);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--theme-mid);
    color: var(--theme2);
    font-size: var(--fs-sm);
    animation: rise var(--dur) var(--ease);
  }

  .pickbar .count {
    color: var(--color2);
    white-space: nowrap;
  }

  .pickbar .why {
    color: var(--muted);
    font-size: var(--fs-xs);
    min-width: 0;
  }

  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }

  .away-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }
</style>
