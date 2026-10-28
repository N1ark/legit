<script lang="ts">
  // The branch list: local branches, a "Create branch" entry for a new name, remote branches
  // without a local one, and recently deleted branches. Type to filter, ↑/↓ and ↵, or right-click
  // a row for its menu. In merge or rebase mode it lists the branches to merge or rebase onto
  // instead: local ones but the current one, and every remote one, as in rebuild mode (the default
  // branch first); in copy mode, the local ones to cherry-pick commits onto. The arrow on a branch
  // lists its commits the current one doesn't have, to cherry-pick some here. A branch checked out
  // in another worktree switches to that worktree.
  // In upstream mode, it lists the remote branches a local one can track, and names not on a remote yet.
  import {
    Button, ConfirmButton, Highlight, IconButton, Kbd, Popover, VirtualList, formatRelative, isMac, menu, rank, toast, tooltip, type MaybeEntry,
  } from 'purr';
  import { ArrowCounterClockwiseRegular, ArrowLeftRegular, ArrowsLeftRightRegular, CaretDownRegular, CaretRightRegular, CheckBold, CheckSquareFill, CloudArrowDownRegular, CloudArrowUpRegular, CopyRegular, CopySimpleRegular, FolderPlusRegular, FolderSimpleRegular, GitBranchRegular, GitMergeRegular, GitPullRequestRegular, LinkBreakRegular, PencilSimpleRegular, PlusBold, PlusRegular, SquareRegular, StackRegular, TrashRegular, XRegular } from 'purr/glyphs';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { BranchInfo, CommitInfo, DeletedBranch, RemoteBranchInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import {
    commitsRequest, deleteBranch, deleteBranches, deleteRemoteBranch, deleteRemoteBranches, lists, newBranch, rebuild, renameBranch,
    restoreBranch, setUpstream, switchOp, unsetUpstream,
  } from './lib/branches.svelte.ts';
  import { integrateEntries } from './lib/integrate.ts';
  import { pick } from './lib/picker.ts';
  import { tip } from './lib/tip.ts';
  import { aheadBehind, trackTip } from './lib/track.ts';
  import { newWorktree, openWorktree } from './lib/worktrees.svelte.ts';
  import Markdown from './Markdown.svelte';
  import PrStatus from './gh/PrStatus.svelte';
  import { prs } from './lib/gh-prs.svelte.ts';

  type Row =
    | { kind: 'local'; b: BranchInfo; indices: number[] }
    | { kind: 'create'; name: string }
    | { kind: 'remote'; b: RemoteBranchInfo; indices: number[] }
    | { kind: 'deleted'; b: DeletedBranch; indices: number[] }
    | { kind: 'publish'; remote: string; name: string };

  /** Deleted branches shown while the filter is empty. */
  const DELETED_SHOWN = 8;

  type Mode = 'switch' | 'merge' | 'rebase' | 'rebuild' | 'copy' | 'commits' | 'upstream';
  let mode = $state<Mode>('switch');
  let open = $state(false);
  let local = $state.raw<BranchInfo[] | null>(null);
  let remote = $state.raw<RemoteBranchInfo[]>([]);
  let deleted = $state.raw<DeletedBranch[]>([]);
  let filter = $state('');
  let active = $state(0);
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  /** Commits to copy to the branch picked (copy mode), or to rebuild this one with on it (rebuild mode). */
  let copying = $state<string[]>([]);
  /** The branch whose commits are listed (commits mode), those commits, and the ones picked. */
  let browsing = $state<string | null>(null);
  let theirs = $state.raw<{ commits: CommitInfo[]; total: number } | null>(null);
  const picked = new SvelteSet<string>();
  /** Branches selected with ⌘/⇧-click (switch mode), by row key; where a ⇧-click range starts, and those selected then. */
  const chosen = new SvelteSet<string>();
  let anchor = $state<string | null>(null);
  let pickedBefore: string[] = [];
  /** The branch whose upstream is being picked (upstream mode), and the remotes, longest name first. */
  let tracker = $state<string | null>(null);
  let remoteNames = $state.raw<string[]>([]);

  const disabled = $derived(!!app.repo?.blocked || app.busy);
  const here = $derived(app.repo?.branch ?? null);
  const names = $derived(new Set((local ?? []).map((b) => b.name)));
  /** The current branch, whose upstream the list shows (the other branches' are in their menus). */
  const hereInfo = $derived(local?.find((b) => b.current) ?? null);
  const tracked = $derived(mode === 'upstream' ? (local?.find((b) => b.name === tracker) ?? null) : null);
  const isUpstream = (remote: string, name: string) => tracked?.tracking?.remote === remote && tracked.tracking.branch === name;

  /** Branches to track that aren't on a remote yet: the name typed (or the branch's own) on each remote, or on the remote typed. */
  function publishRows(typed: string): Row[] {
    const on = remoteNames.find((r) => typed.startsWith(`${r}/`));
    const name = on ? typed.slice(on.length + 1) : typed || (tracker ?? '');
    if (!name || /\s/.test(name)) return [];
    const there = new Set(remote.map((b) => `${b.remote}/${b.name}`));
    return (on ? [on] : [...remoteNames].sort())
      .filter((r) => !there.has(`${r}/${name}`))
      .map((r): Row => ({ kind: 'publish', remote: r, name }));
  }

  const rowName = (r: Row) => (r.kind === 'local' ? r.b.name : r.kind === 'remote' ? `${r.b.remote}/${r.b.name}` : null);

  const rows = $derived.by((): Row[] => {
    if (!local) return [];
    const typed = filter.trim();
    if (mode === 'upstream') {
      const out = rank(remote, filter, { keys: [(b) => `${b.remote}/${b.name}`] }).map(({ item, indices }): Row => ({ kind: 'remote', b: item, indices }));
      if (!typed) out.sort((a, b) => Number(current(b)) - Number(current(a)));
      return [...out, ...publishRows(typed)];
    }
    const shown = mode === 'switch' ? local : local.filter((b) => !b.current);
    const out: Row[] = rank(shown, filter, { keys: [(b) => b.name] }).map(({ item, indices }) => ({ kind: 'local', b: item, indices }));
    if (mode === 'copy' || mode === 'commits') return out;
    if (mode !== 'switch') {
      for (const { item, indices } of rank(remote, filter, { keys: [(b) => `${b.remote}/${b.name}`] })) out.push({ kind: 'remote', b: item, indices });
      const base = mode === 'rebuild' && !typed ? out.findIndex((r) => rowName(r) === app.repo?.base?.name) : -1;
      return base > 0 ? [out[base], ...out.slice(0, base), ...out.slice(base + 1)] : out;
    }
    if (typed && !names.has(typed) && !/\s/.test(typed)) out.push({ kind: 'create', name: typed });
    for (const { item, indices } of rank(remote, filter, { keys: [(b) => `${b.remote}/${b.name}`] })) {
      out.push({ kind: 'remote', b: item, indices });
    }
    const gone = rank(deleted, filter, { keys: [(b) => b.name] });
    for (const { item, indices } of typed ? gone : gone.slice(0, DELETED_SHOWN)) out.push({ kind: 'deleted', b: item, indices });
    return out;
  });
  /** The default branch is listed first (and so picked by ↵) when rebuilding. */
  const promoted = $derived(mode === 'rebuild' && !filter.trim() && !!rows[0] && rowName(rows[0]) === app.repo?.base?.name);

  const key = (r: Row) =>
    r.kind === 'create' ? `create:${r.name}`
    : r.kind === 'publish' ? `publish:${r.remote}/${r.name}`
    : r.kind === 'local' ? `local:${r.b.name}`
    : `${r.kind}:${r.b.ref}`;
  const HEADINGS: Partial<Record<Row['kind'], string>> = {
    remote: 'Remote branches', deleted: 'Recently deleted', publish: 'Not on the remote yet',
  };

  /** The rows with their section headings, as the virtual list lays them out; `at[k]` is row k's place. */
  const laid = $derived.by(() => {
    const items: ({ key: string; heading: string } | { key: string; heading?: undefined; r: Row; k: number })[] = [];
    const at: number[] = [];
    rows.forEach((r, k) => {
      if (HEADINGS[r.kind] && rows[k - 1]?.kind !== r.kind && !(promoted && k === 0)) items.push({ key: `heading:${r.kind}`, heading: HEADINGS[r.kind]! });
      at.push(items.length);
      items.push({ key: key(r), r, k });
    });
    return { items, at };
  });
  const items = $derived(laid.items);
  let rowsEl = $state<HTMLElement>();
  let vlist = $state<{ scrollToIndex: (index: number) => void }>();
  /** Row and heading heights, which follow the theme's tokens: measured off-screen when the list shows. */
  let probe = $state<HTMLElement>();
  let sizes = $state({ row: 24, heading: 29 });
  $effect(() => {
    // The layout height, not the box on screen: the popover may still be scaling in.
    const [heading, row] = probe ? [...probe.children].map((e) => parseFloat(getComputedStyle(e).height)) : [];
    if (heading && row) sizes = { row, heading };
  });

  /** The current branch, or in upstream mode the branch's current upstream. */
  function current(r: Row): boolean {
    if (mode === 'upstream') return r.kind === 'remote' ? isUpstream(r.b.remote, r.b.name) : r.kind === 'publish' && isUpstream(r.remote, r.name);
    return r.kind === 'local' && r.b.current;
  }

  /** The listed branch's commits, filtered by title or SHA. */
  const commitRows = $derived(
    theirs ? rank(theirs.commits, filter, { keys: [(c) => c.subject, (c) => c.sha.slice(0, 7)] }).map(({ item }) => item) : [],
  );

  /** Bumped by each load, so only the last one shows. */
  let loads = 0;

  async function load() {
    const n = ++loads;
    if (mode === 'commits') {
      const r = await fetch(`/api/branches/commits?branch=${encodeURIComponent(browsing ?? '')}`);
      const data = await r.json();
      if (n !== loads) return;
      if (!r.ok) {
        toast.error(data.error ?? r.statusText);
        return setMode('switch');
      }
      theirs = data;
      return;
    }
    const [l, r, d, names] = [lists.local, mode === 'switch' ? lists.remote : lists.allRemote, lists.deleted, lists.remotes];
    const named = mode === 'upstream';
    // What was listed in this same state shows at once, as it's asked for again.
    if (local === null && l.cached && r.cached && d.cached && (!named || names.cached)) apply(l.cached, r.cached, d.cached, named ? names.cached : null);
    try {
      const got = await Promise.all([l.load(), r.load(), d.load(), named ? names.load() : null]);
      if (n === loads) apply(...got);
    } catch (e) {
      if (n === loads) toast.error(e);
    }
  }

  function apply(l: BranchInfo[], r: RemoteBranchInfo[], d: DeletedBranch[], names: string[] | null) {
    [local, remote, deleted] = [l, r, d];
    if (names) remoteNames = names;
    const left = new Set([...l.map((b) => `local:${b.name}`), ...r.map((b) => `remote:${b.ref}`)]);
    for (const k of [...chosen]) if (!left.has(k)) chosen.delete(k);
  }

  // While it's open, the list follows what changes in the repository (a fetch, a commit from a terminal…).
  $effect(() => {
    void app.repo;
    untrack(() => open && mode !== 'commits' && local !== null && load());
  });

  /**
   * Open the list to switch branch, or to pick one to merge, rebase or rebuild onto (or to copy
   * commits to), or for `branch` (else the current one) to track.
   */
  export async function show(m: Mode = 'switch', branch?: string) {
    if (disabled) return;
    if ((m === 'merge' || m === 'rebase' || m === 'rebuild' || (m === 'upstream' && !branch)) && !here) return toast.error('HEAD is detached: switch to a branch first.');
    if (m === 'upstream') tracker = branch ?? here;
    open = true;
    filter = '';
    await setMode(m);
  }

  async function setMode(m: Mode) {
    mode = m;
    active = 0;
    chosen.clear();
    anchor = null;
    local = null;
    theirs = null;
    filter = '';
    await load();
    input?.focus();
  }

  // Copy to branch… and Rebuild on… in the commit list open the list to pick the branch.
  $effect(() => {
    const req = commitsRequest.pending;
    if (!req) return;
    commitsRequest.pending = null;
    copying = req.shas;
    show(req.mode);
  });

  /** List `name`'s commits that the current branch doesn't have, to cherry-pick some. */
  function browse(name: string) {
    browsing = name;
    picked.clear();
    setMode('commits');
  }

  function togglePick(sha: string) {
    if (picked.has(sha)) picked.delete(sha);
    else picked.add(sha);
  }

  function cherryPick() {
    if (!picked.size || app.busy) return;
    open = false;
    app.sync('cherryPick', { shas: [...picked] }, undefined, true);
  }

  /** Run an action from the list; on success the list closes, or reloads with `stay`. */
  async function act(run: () => Promise<boolean>, stay = false) {
    if (!(await run())) return;
    if (stay && open) await load();
    else open = false;
  }

  const many = (n: number) => `${n} branch${n === 1 ? '' : 'es'}`;
  /** A branch's upstream when it's a remote-tracking branch (`<remote>/<branch>`); the server checks it names a remote. */
  const remoteUpstream = (b: BranchInfo) => (b.upstream?.includes('/') && b.track !== 'gone' ? b.upstream : '');
  const selectable = (r: Row) => mode === 'switch' && (r.kind === 'local' || r.kind === 'remote');
  const isChosen = (r: Row) => selectable(r) && chosen.has(key(r));

  const selection = $derived((local ?? []).filter((b) => chosen.has(`local:${b.name}`)));
  /** The remote branches selected, deleted on their remotes with the rest. */
  const remoteSelection = $derived(remote.filter((b) => chosen.has(`remote:${b.ref}`)));
  const deletable = $derived(selection.filter((b) => !b.current && !b.worktree));
  const kept = $derived(
    selection
      .filter((b) => b.current || b.worktree)
      .map((b) => `${b.name} (${b.worktree ? `checked out in ${folder(b.worktree)}` : "you're on it"})`),
  );
  const upstreams = $derived(
    deletable.map(remoteUpstream).filter(Boolean).map((u) => `refs/remotes/${u}`).filter((ref) => !remoteSelection.some((b) => b.ref === ref)),
  );
  const toDelete = $derived(deletable.length + remoteSelection.length);

  /**
   * ⌘/Ctrl-click adds or removes a branch, local or remote, ⇧-click adds the range from the last one
   * ⌘-clicked (as in Finder, see `pick`); a plain click chooses it.
   */
  function onrowclick(e: MouseEvent, r: Row) {
    const toggle = isMac ? e.metaKey : e.ctrlKey;
    if (!selectable(r) || !(toggle || e.shiftKey)) return choose(r);
    const shown = rows.filter(selectable).map(key);
    const next = pick({ chosen: [...chosen], anchor, base: pickedBefore }, shown, key(r), e.shiftKey);
    chosen.clear();
    for (const k of next.chosen) chosen.add(k);
    [anchor, pickedBefore] = [next.anchor, next.base];
  }

  /** Delete the selected branches, here and on their remotes; the server skips the ones that can't be, and the toasts say which. */
  async function deleteChosen() {
    const names = selection.map((b) => b.name);
    const refs = remoteSelection.map((b) => b.ref);
    const ok = (!names.length || (await deleteBranches(names))) && (!refs.length || (await deleteRemoteBranches(refs)));
    if (ok) chosen.clear();
    return ok;
  }

  /** What deleting the selection does beyond this repo, and what it leaves. */
  const bulkNote = $derived(
    [remoteSelection.length && `${remoteSelection.length} on the remote, for everyone`, kept.length && `skips ${kept.join(', ')}`, 'restorable for two weeks']
      .filter(Boolean)
      .join(' · '),
  );

  function bulkMenu(): MaybeEntry[] {
    const n = toDelete;
    return [
      {
        label: `Delete ${many(n)}`,
        icon: TrashRegular,
        danger: true,
        disabled: !n,
        note: bulkNote,
        confirm: `Delete ${many(n)}`,
        run: () => act(deleteChosen, true),
      },
      !!upstreams.length && {
        label: upstreams.length === 1 ? 'Delete its upstream on the remote…' : `Delete their ${upstreams.length} upstreams on the remote…`,
        icon: TrashRegular,
        danger: true,
        note: `${upstreams.map((u) => u.slice('refs/remotes/'.length)).join(', ')}, for everyone. Each is refused if it moved since you last fetched.`,
        confirm: `Delete ${upstreams.length} on the remote`,
        run: () => act(() => deleteRemoteBranches(upstreams), true),
      },
      'separator',
      { label: 'Clear selection', icon: XRegular, run: () => chosen.clear() },
    ];
  }

  /** Pick what `name` tracks. */
  function pickUpstream(name: string) {
    tracker = name;
    setMode('upstream');
  }

  async function track(remote: string, name: string, exists: boolean) {
    if (!tracked || isUpstream(remote, name)) return;
    if (await setUpstream(tracked, remote, name, exists)) await setMode('switch');
  }

  async function stopTracking() {
    if (tracked && (await unsetUpstream(tracked))) await setMode('switch');
  }

  function choose(r: Row | undefined) {
    if (!r) return;
    if (mode === 'upstream') {
      if (r.kind === 'remote') track(r.b.remote, r.b.name, true);
      else if (r.kind === 'publish') track(r.remote, r.name, false);
    } else if (mode === 'copy' && r.kind === 'local') {
      open = false;
      app.sync('copyTo', { shas: copying, branch: r.b.name }, undefined, true);
    } else if (mode === 'rebuild' && (r.kind === 'local' || r.kind === 'remote')) {
      open = false;
      rebuild(copying, rowName(r)!);
    } else if (mode !== 'switch' && (r.kind === 'local' || r.kind === 'remote')) {
      open = false;
      app.sync(mode, { branch: r.kind === 'local' ? r.b.name : `${r.b.remote}/${r.b.name}` });
    } else if (r.kind === 'local') {
      const worktree = r.b.worktree;
      if (r.b.current || worktree) open = false;
      if (worktree) openWorktree(worktree);
      else if (!r.b.current) act(() => switchOp('switch', { branch: r.b.name }, r.b.name));
    } else if (r.kind === 'create') act(() => switchOp('createBranch', { name: r.name }, r.name));
    else if (r.kind === 'remote') act(() => switchOp('checkoutRemote', { ref: r.b.ref }, r.b.name));
    else if (r.kind === 'deleted') act(() => restoreBranch(r.b, names.has(r.b.name)), true);
  }

  const copyName = (name: string): MaybeEntry => ({ label: 'Copy name', icon: CopyRegular, run: () => app.copy(name, 'the branch name') });

  /** The folder's name of a worktree's path. */
  const folder = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

  function addWorktree(start?: Parameters<typeof newWorktree>[0]) {
    open = false;
    newWorktree(start);
  }

  /** A local branch's menu. Entries for other actions on a branch go in their own section. */
  function localMenu(b: BranchInfo): MaybeEntry[] {
    const upstream = remoteUpstream(b);
    return [
      !b.current && {
        label: b.worktree ? `Switch to its worktree (${folder(b.worktree)})` : 'Switch to it',
        icon: b.worktree ? FolderSimpleRegular : ArrowsLeftRightRegular,
        run: () => choose({ kind: 'local', b, indices: [] }),
      },
      !b.current && !b.worktree && { label: 'New worktree for it…', icon: FolderPlusRegular, run: () => addWorktree({ branch: b.name }) },
      { label: 'New branch from here…', icon: PlusRegular, run: () => act(() => newBranch(b.sha, b.name), true) },
      { label: 'Rename…', icon: PencilSimpleRegular, run: () => act(() => renameBranch(b.name), true) },
      !b.current && !!here && { label: 'Cherry-pick from it…', icon: CopySimpleRegular, run: () => browse(b.name) },
      copyName(b.name),
      'separator',
      {
        label: 'Set upstream…',
        icon: CloudArrowUpRegular,
        note: b.upstream ? `Tracks ${b.upstream}. Pick another remote branch, or a new one to publish to.` : 'Pick a remote branch to push to and pull from.',
        run: () => pickUpstream(b.name),
      },
      !!b.upstream && { label: 'Stop tracking', icon: LinkBreakRegular, note: `Forget ${b.upstream}. The next push publishes it under its own name.`, run: () => act(() => unsetUpstream(b), true) },
      'separator',
      ...integrateEntries(b.name, b.current, () => (open = false)),
      'separator',
      {
        label: 'Delete',
        icon: TrashRegular,
        danger: true,
        disabled: b.current || !!b.worktree,
        note: b.current
          ? "You're on it; switch to another branch first."
          : b.worktree
            ? `It's checked out in ${folder(b.worktree)}; remove that worktree first.`
            : 'Restorable for two weeks.',
        confirm: `Delete ${b.name}`,
        run: () => act(() => deleteBranch(b.name), true),
      },
      !!upstream && {
        label: `Delete ${upstream} on the remote…`,
        icon: TrashRegular,
        danger: true,
        note: "For everyone. Refused if it moved since you last fetched.",
        confirm: `Delete ${upstream} on the remote`,
        run: () => act(() => deleteRemoteBranch(`refs/remotes/${upstream}`), true),
      },
    ];
  }

  function remoteMenu(b: RemoteBranchInfo): MaybeEntry[] {
    const short = `${b.remote}/${b.name}`;
    return [
      { label: `Check out as ${b.name}`, icon: CloudArrowDownRegular, run: () => choose({ kind: 'remote', b, indices: [] }) },
      {
        label: `Check out as ${b.name} in a new worktree…`,
        icon: FolderPlusRegular,
        run: () => addWorktree({ branch: b.name, from: short, what: short, track: true }),
      },
      { label: 'New branch from here…', icon: PlusRegular, run: () => act(() => newBranch(b.sha, short), true) },
      !!here && { label: 'Cherry-pick from it…', icon: CopySimpleRegular, run: () => browse(short) },
      copyName(short),
      'separator',
      ...integrateEntries(short, false, () => (open = false)),
      'separator',
      {
        label: `Delete on ${b.remote}…`,
        icon: TrashRegular,
        danger: true,
        note: "For everyone. Refused if it moved since you last fetched.",
        confirm: `Delete ${short} on the remote`,
        run: () => act(() => deleteRemoteBranch(b.ref), true),
      },
    ];
  }

  function deletedMenu(b: DeletedBranch): MaybeEntry[] {
    return [
      { label: 'Restore', icon: ArrowCounterClockwiseRegular, run: () => choose({ kind: 'deleted', b, indices: [] }) },
      { label: 'Restore as…', icon: PencilSimpleRegular, run: () => act(() => restoreBranch(b, true), true) },
      { label: 'Copy SHA', icon: CopyRegular, run: () => app.copy(b.sha, shortSha(b.sha)) },
    ];
  }

  function oncontextmenu(e: MouseEvent, r: Row, k: number) {
    active = k;
    if (r.kind === 'create' || r.kind === 'publish' || mode === 'upstream') return e.preventDefault();
    if (isChosen(r) && chosen.size > 1) return menu.show(e, bulkMenu(), `${chosen.size} branches selected`);
    const list = r.kind === 'local' ? localMenu(r.b) : r.kind === 'remote' ? remoteMenu(r.b) : deletedMenu(r.b);
    menu.show(e, list, r.kind === 'remote' ? `${r.b.remote}/${r.b.name}` : r.b.name);
  }

  /** The current branch's menu, from a right-click on the button (the list has it too). */
  async function buttonMenu(e: MouseEvent) {
    e.preventDefault();
    if (!here) return;
    const { clientX: x, clientY: y } = e;
    try {
      const b = (await lists.local.load()).find((b) => b.current);
      if (b) menu.showAt(x, y, localMenu(b), b.name);
    } catch (err) {
      toast.error(err);
    }
  }

  /** The branch a row stands for, to list its commits; null for rows without any to pick. */
  function browsable(r: Row | undefined): string | null {
    if (!here || !r) return null;
    if (r.kind === 'local') return r.b.current ? null : r.b.name;
    return r.kind === 'remote' ? `${r.b.remote}/${r.b.name}` : null;
  }

  function onkeydown(e: KeyboardEvent) {
    if (mode === 'commits') return onCommitsKey(e);
    const field = e.currentTarget as HTMLInputElement;
    if (e.key === 'ArrowRight' && mode === 'switch' && field.selectionStart === field.value.length) {
      const name = browsable(rows[active]);
      if (name) {
        e.preventDefault();
        browse(name);
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      vlist?.scrollToIndex(laid.at[active] ?? -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    }
  }

  function onCommitsKey(e: KeyboardEvent) {
    const n = commitRows.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      cherryPick();
    } else if (e.key === 'Enter' && commitRows[active]) {
      e.preventDefault();
      togglePick(commitRows[active].sha);
    }
  }
</script>

<button
  bind:this={button}
  class="btn btn--ghost branch"
  onclick={() => (open ? (open = false) : show())}
  oncontextmenu={buttonMenu}
  onpointerenter={() => open || [lists.local, lists.remote, lists.deleted].forEach((l) => l.warm())}
  {disabled}
  aria-expanded={open}
  use:tooltip={'Switch branch (b)'}
>
  <GitBranchRegular />
  <span>{app.repo?.branch ?? `detached @ ${app.repo?.head ? shortSha(app.repo.head) : '?'}`}</span>
  <CaretDownRegular />
</button>
{#if open && button}
  <Popover
    anchor={button}
    label={mode === 'merge'
      ? 'Merge a branch'
      : mode === 'rebase'
        ? 'Rebase onto a branch'
        : mode === 'rebuild'
          ? 'Rebuild on a branch'
          : mode === 'copy'
            ? 'Copy commits to a branch'
            : mode === 'commits'
              ? `Commits on ${browsing}`
              : mode === 'upstream'
                ? `Upstream of ${tracker}`
              : 'Branches'}
    onclose={() => (open = false)}
    width="min(560px, calc(100vw - 32px))"
    padding="var(--gap-4)"
    autofocus
  >
    <div class="panel">
      {#if mode !== 'switch'}
        <div class="mode">
          <IconButton label="Back to switching branches" size="sm" onclick={() => setMode('switch')}><ArrowLeftRegular /></IconButton>
          {#if mode === 'merge'}<GitMergeRegular /> Merge a branch into <b class="mono">{here}</b>
          {:else if mode === 'rebase'}<GitPullRequestRegular /> Rebase <b class="mono">{here}</b> onto a branch
          {:else if mode === 'rebuild'}<StackRegular /> Rebuild <b class="mono">{here}</b> on a branch with {copying.length === 1 ? '1 commit' : `${copying.length} commits`}
          {:else if mode === 'copy'}<CopySimpleRegular /> Copy {copying.length === 1 ? '1 commit' : `${copying.length} commits`} to a branch
          {:else if mode === 'upstream'}<CloudArrowUpRegular /> What <b class="mono">{tracker}</b> pushes to and pulls from
            {#if tracked?.upstream}<span class="muted">(now <span class="mono">{tracked.upstream}</span>)</span>{/if}
          {:else}<GitBranchRegular /> Commits on <b class="mono">{browsing}</b> that <b class="mono">{here}</b> doesn't have{/if}
        </div>
      {/if}
      <input
        bind:this={input}
        bind:value={filter}
        oninput={() => (active = 0)}
        {onkeydown}
        placeholder={mode === 'merge'
          ? 'Branch to merge…'
          : mode === 'rebase'
            ? 'Branch to rebase onto…'
            : mode === 'rebuild'
              ? 'Branch to rebuild on…'
              : mode === 'copy'
                ? 'Branch to copy to…'
                : mode === 'commits'
                  ? 'Filter commits…'
                  : mode === 'upstream'
                    ? 'Remote branch, or a new name…'
                  : 'Branch…'}
        spellcheck="false"
        class="field-input mono"
      />
      {#if mode === 'commits'}
        {#if theirs === null}
          <p class="muted">Loading…</p>
        {:else if !commitRows.length}
          <p class="muted">{theirs.commits.length ? 'No matching commit.' : `${here} already has every commit of ${browsing}.`}</p>
        {:else}
          <ol bind:this={listEl} role="listbox" aria-label="Commits on {browsing}" aria-multiselectable="true">
            {#each commitRows as c, k (c.sha)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="row-item commit-pick"
                class:is-cursor={k === active}
                role="option"
                aria-selected={picked.has(c.sha)}
                data-row={k}
                onclick={() => togglePick(c.sha)}
                onmousemove={() => (active = k)}
              >
                <span class="check">{#if picked.has(c.sha)}<CheckSquareFill />{:else}<SquareRegular />{/if}</span>
                <span class="sha mono">{shortSha(c.sha)}</span>
                <span class="subject" use:tooltip={c.subject}><Markdown text={c.subject} inline links="off" /></span>
                <span class="when muted">{c.author.name} · {formatRelative(c.author.time * 1000)}</span>
              </li>
            {/each}
            {#if theirs.total > theirs.commits.length}
              <li class="heading muted" role="presentation">…and {theirs.total - theirs.commits.length} older</li>
            {/if}
          </ol>
        {/if}
      {:else if local === null}
        <p class="muted">Loading…</p>
      {:else if !rows.length}
        <p class="muted">No match</p>
      {:else}
        <!-- Only the rows in view are mounted: a repo can have hundreds of branches. -->
        <div class="rows" bind:this={rowsEl} role="listbox" aria-label="Branches" aria-multiselectable={mode === 'switch'}>
          <div class="probe" aria-hidden="true" bind:this={probe}><div><div class="heading">x</div></div><div><div class="row-item opt">x</div></div></div>
          {#if rowsEl}
            <VirtualList bind:this={vlist} {items} rowHeight={(it) => (it.heading !== undefined ? sizes.heading : sizes.row)} key={(it) => it.key} scroller={rowsEl}>
              {#snippet children(it)}
                {#if it.heading !== undefined}
                  <div class="heading muted" role="presentation">{it.heading}</div>
                {:else}
                  {@const r = it.r}
                  {@const k = it.k}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
                  <div
                    class="row-item opt"
                    class:is-cursor={k === active}
                    class:is-current={isChosen(r)}
                    class:current={current(r)}
                    role="option"
                    aria-selected={chosen.size ? isChosen(r) : k === active}
                    data-row={k}
                    onclick={(e) => onrowclick(e, r)}
                    onmousedown={(e) => e.shiftKey && e.preventDefault()}
                    oncontextmenu={(e) => oncontextmenu(e, r, k)}
                    onmousemove={() => (active = k)}
                  >
                    {#if r.kind === 'create'}
                      <span class="check"><PlusBold /></span>
                      <span class="name">Create branch <b class="mono">{r.name}</b></span>
                      <span class="subject muted">from {app.repo?.branch ?? 'HEAD'}</span>
                    {:else if r.kind === 'publish'}
                      <span class="check">{#if current(r)}<CheckBold />{:else}<CloudArrowUpRegular />{/if}</span>
                      <span class="name mono">{r.remote}/{r.name}</span>
                      <span class="subject muted">{current(r) ? 'tracked · ' : ''}not on {r.remote} yet; push publishes it</span>
                    {:else if r.kind === 'local'}
                      {@const b = r.b}
                      <span class="check">{#if isChosen(r)}<CheckSquareFill />{:else if b.current}<CheckBold />{/if}</span>
                      <span class="name mono" {@attach () => prs.want('local', b.name)}><Highlight text={b.name} indices={r.indices} /></span>
                      <span class="subject muted" use:tooltip={b.subject}><Markdown text={b.subject} inline links="off" /></span>
                      {#if prs.byBranch[b.name]}{@const pr = prs.byBranch[b.name]}<PrStatus state={pr.state} number={pr.number} title={pr.title} />{/if}
                      {#if b.worktree}
                        <span class="worktree muted" use:tooltip={`Checked out in ${b.worktree}; picking it switches there`}>
                          <FolderSimpleRegular />{folder(b.worktree)}
                        </span>
                      {/if}
                      {#if promoted && k === 0}<span class="default">default branch</span>{/if}
                      {#if b.track === 'gone'}
                        <span class="track" use:tooltip={`${b.upstream} isn't on the remote; the next push publishes it`}>not on remote</span>
                      {:else if b.track}{@const n = aheadBehind(b.track)}
                        {#if n}
                          <span class="track counts" use:tooltip={trackTip(b.upstream ?? 'its upstream', n.ahead, n.behind)}>
                            {#if n.ahead}↑{n.ahead}{/if}{#if n.ahead && n.behind}&nbsp;{/if}{#if n.behind}↓{n.behind}{/if}
                          </span>
                        {:else}<span class="track">{b.track}</span>{/if}
                      {/if}
                      <span class="when muted">{formatRelative(b.time * 1000)}</span>
                      {@render browseButton(r)}
                    {:else if r.kind === 'remote'}
                      {@const b = r.b}
                      <span class="check">{#if isChosen(r)}<CheckSquareFill />{:else if current(r)}<CheckBold />{:else}<CloudArrowDownRegular />{/if}</span>
                      <span class="name mono" {@attach () => prs.want('remote', `${b.remote}/${b.name}`)}><Highlight text="{b.remote}/{b.name}" indices={r.indices} /></span>
                      <span class="subject muted" use:tooltip={b.subject}><Markdown text={b.subject} inline links="off" /></span>
                      {#if prs.byRemote[`${b.remote}/${b.name}`]}{@const pr = prs.byRemote[`${b.remote}/${b.name}`]}<PrStatus state={pr.state} number={pr.number} title={pr.title} />{/if}
                      {#if promoted && k === 0}<span class="default">default branch</span>{/if}
                      <span class="when muted">{formatRelative(b.time * 1000)}</span>
                      {@render browseButton(r)}
                    {:else}
                      {@const b = r.b}
                      <span class="check"><ArrowCounterClockwiseRegular /></span>
                      <span class="name mono gone"><Highlight text={b.name} indices={r.indices} /></span>
                      <span class="subject muted" use:tooltip={b.subject}>{b.remote ? `deleted on ${b.remote}` : shortSha(b.sha)} · <Markdown text={b.subject} inline links="off" /></span>
                      <span class="when muted">{formatRelative(b.time)}</span>
                    {/if}
                  </div>
                {/if}
              {/snippet}
            </VirtualList>
          {/if}
        </div>
      {/if}
      {#if mode === 'switch' && chosen.size > 1}
        <div class="pick bulk">
          <span class="foot muted">{chosen.size} selected · {bulkNote}</span>
          <Button size="sm" variant="ghost" onclick={() => chosen.clear()}><XRegular /> Clear</Button>
          <ConfirmButton
            size="sm"
            confirmLabel="Click again to delete {many(toDelete)}"
            disabled={!toDelete || app.busy}
            onconfirm={() => act(deleteChosen, true)}
          >
            <TrashRegular /> Delete {many(toDelete)}
          </ConfirmButton>
        </div>
      {/if}
      {#if mode === 'switch'}
        <div class="modes">
          <Button size="sm" variant="ghost" disabled={!here} onclick={() => setMode('merge')} {@attach tip('Merge a branch into this one (m)')}>
            <GitMergeRegular /> Merge…
          </Button>
          <Button size="sm" variant="ghost" disabled={!here} onclick={() => setMode('rebase')} {@attach tip('Rebase onto a branch (r)')}>
            <GitPullRequestRegular /> Rebase on…
          </Button>
          <Button size="sm" variant="ghost" onclick={() => addWorktree()} {@attach tip('Check a branch out in a folder of its own')}>
            <FolderPlusRegular /> New worktree…
          </Button>
          {#if hereInfo}
            <span class="tracks">
              <Button
                size="sm"
                variant="ghost"
                onclick={() => pickUpstream(hereInfo.name)}
                {@attach tip(hereInfo.upstream ? `${hereInfo.name} pushes to and pulls from it; click to change` : `${hereInfo.name} tracks nothing; click to pick`)}
              >
                <CloudArrowUpRegular /> <span class="mono">{hereInfo.upstream ?? 'No upstream'}</span>
              </Button>
            </span>
          {/if}
        </div>
        <p class="foot muted">
          Right-click for more · <span class="mono">→</span> cherry-pick · <span class="mono">{isMac ? '⌘' : 'Ctrl'}</span>/<span class="mono">⇧</span>-click to select
        </p>
      {:else if mode === 'commits'}
        <div class="pick">
          <Button variant="primary" size="sm" disabled={!picked.size || app.busy} onclick={cherryPick}>
            <CopySimpleRegular /> Cherry-pick {picked.size ? `${picked.size} ` : ''}onto {here} <Kbd hint="⌘↩" />
          </Button>
          <span class="foot muted">
            Oldest first · <span class="mono">⌘Z</span> undoes
          </span>
        </div>
      {:else if mode === 'upstream'}
        <div class="pick">
          {#if tracked?.upstream}
            <Button size="sm" variant="ghost" disabled={app.busy} onclick={stopTracking}>
              <LinkBreakRegular /> Stop tracking
            </Button>
          {/if}
          <span class="foot muted">
            Type a name to publish to a new one
          </span>
        </div>
      {:else if mode === 'copy'}
        <p class="foot muted">
          Refused if anything conflicts · <span class="mono">⌘Z</span> undoes
        </p>
      {:else if mode === 'rebuild'}
        <p class="foot muted">
          Other commits on {here} are dropped · <span class="mono">⌘Z</span> undoes
        </p>
      {:else if mode === 'merge'}
        <p class="foot muted">
          Needs no uncommitted changes · <span class="mono">⌘Z</span> undoes
        </p>
      {:else}
        <p class="foot muted">
          Uncommitted changes come along · <span class="mono">⌘Z</span> undoes
        </p>
      {/if}
    </div>
  </Popover>
{/if}

{#snippet browseButton(r: Row)}
  {@const name = mode === 'switch' ? browsable(r) : null}
  {#if name}
    <IconButton
      size="sm"
      label="Show the commits of {name} that {here} doesn't have"
      tip="Commits to cherry-pick (→)"
      onclick={(e) => {
        e.stopPropagation();
        browse(name);
      }}
    >
      <CaretRightRegular />
    </IconButton>
  {/if}
{/snippet}

<style>
  .branch {
    font-family: var(--mono);
    font-weight: 400;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  p {
    margin: var(--gap-2) var(--gap-3);
  }

  ol,
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }

  .rows {
    position: relative;
  }

  /* Out of the way, and adding nothing to what scrolls. */
  .probe {
    position: absolute;
    width: 100%;
    height: 0;
    overflow: hidden;
    visibility: hidden;
  }

  li,
  .opt {
    cursor: pointer;
    font-size: var(--fs-base);
  }

  .heading {
    flex: 1;
    min-width: 0;
  }

  li.heading,
  .heading {
    cursor: default;
    font-size: var(--fs-xs);
    padding: var(--sp-4) var(--gap-3) var(--gap-2);
  }

  .check {
    width: 12px;
    display: flex;
    flex-shrink: 0;
    font-size: var(--icon-sm);
    color: var(--theme2);
  }

  .name {
    color: var(--color2);
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name.gone {
    color: var(--muted);
    text-decoration: line-through;
  }

  .opt.current .name {
    color: var(--theme2);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }

  .worktree {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    font-size: var(--fs-xs);
    flex-shrink: 0;
    max-width: 25%;
    overflow: hidden;
    white-space: nowrap;
  }

  .tracks {
    margin-left: auto;
    min-width: 0;
    display: flex;
  }

  .tracks .mono {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    font-size: var(--fs-xs);
    color: var(--warn);
    flex-shrink: 0;
  }

  .counts {
    font-family: var(--mono);
  }

  .default {
    font-size: var(--fs-xs);
    color: var(--theme2);
    flex-shrink: 0;
  }

  .when {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .foot {
    font-size: var(--fs-xs);
  }

  .sha {
    color: var(--theme2);
    flex-shrink: 0;
    font-size: var(--fs-sm);
  }

  .commit-pick .subject {
    color: var(--color2);
    font-size: var(--fs-base);
  }

  .pick {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding-top: var(--gap-3);
    border-top: 1px solid var(--border);
  }

  .pick .foot {
    flex: 1;
    margin: 0;
  }

  .mode {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    font-size: var(--fs-sm);
    color: var(--color2);
  }

  .mode :global(svg) {
    color: var(--theme2);
  }

  .modes {
    display: flex;
    gap: var(--gap-2);
    padding-top: var(--gap-2);
    border-top: 1px solid var(--border);
  }
</style>
