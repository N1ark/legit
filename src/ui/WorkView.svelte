<script lang="ts">
  // Uncommitted changes: a commit form, what's staged, and what isn't (untracked files
  // included). Select lines like in a commit and stage/unstage them; only the index changes.
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary, Selection, WorkState } from '../shared/types.ts';
  import Coauthors from './Coauthors.svelte';
  import DiffView from './DiffView.svelte';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { formatPerson, parsePeople } from './lib/people.ts';

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';

  type Sel = Record<string, SvelteSet<number>>;
  let work = $state.raw<WorkState | null>(null);
  let staged = $state<Sel>({});
  let unstaged = $state<Sel>({});
  let error = $state<string | null>(null);

  const emptySel = (d: DiffSummary): Sel => Object.fromEntries(d.files.map((f) => [f.path, new SvelteSet<number>()]));

  let loading = false;
  let again = false;
  async function load() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const res = await fetch('/api/work');
      const w: WorkState | { error: string } = await res.json();
      if ('error' in w) error = w.error;
      else {
        error = null;
        // A side whose snapshot didn't change keeps its selection.
        if (w.staged.sha !== work?.staged.sha) staged = emptySel(w.staged);
        if (w.unstaged.sha !== work?.unstaged.sha) unstaged = emptySel(w.unstaged);
        work = w;
      }
    } finally {
      loading = false;
      if (again) {
        again = false;
        load();
      }
    }
  }

  $effect(() => {
    void app.workTick;
    void app.repo?.head;
    load();
  });

  onMount(() => {
    const scroller = document.querySelector('[data-scroller]');
    if (scroller) scroller.scrollTop = 0;
  });

  const count = (sel: Sel) => Object.values(sel).reduce((n, s) => n + s.size, 0);
  const selStaged = $derived(count(staged));
  const selUnstaged = $derived(count(unstaged));

  function selection(d: DiffSummary, sel: Sel, all = false): Selection {
    const out: Selection = {};
    for (const f of d.files) {
      const s = sel[f.path];
      const n = f.added + f.removed;
      if (all || n === 0 ? all || s?.size : s?.size === n) out[f.path] = 'all';
      else if (s?.size) out[f.path] = [...s];
    }
    return out;
  }

  async function run(op: 'stage' | 'unstage', all = false) {
    if (!work || app.busy) return;
    const d = op === 'stage' ? work.unstaged : work.staged;
    const sel = selection(d, op === 'stage' ? unstaged : staged, all);
    if (!Object.keys(sel).length) return;
    await app.op(op, { key: d.sha, selection: sel });
    await load();
  }

  // Commit form.
  let subject = $state('');
  let body = $state('');
  let coauthors = $state<string[]>([]);
  const people = $derived(parsePeople(coauthors));
  const head = $derived(app.commits.find((c) => c.sha === app.repo?.head) ?? null);
  let amend = $state(false);
  const canCommit = $derived(
    subject.trim() !== '' && people !== null && !app.repo?.blocked && (amend ? !!head : !!work?.staged.files.length),
  );

  // Amending starts from the last commit's message; turning it off brings back what was typed.
  let typed: { subject: string; body: string; coauthors: string[] } | null = null;
  function toggleAmend() {
    if (!head) return;
    amend = !amend;
    if (amend) {
      typed = { subject, body, coauthors: [...coauthors] };
      subject = head.subject;
      body = head.body;
      coauthors = head.coauthors.map(formatPerson);
    } else if (typed) {
      ({ subject, body } = typed);
      coauthors = typed.coauthors;
      typed = null;
    }
  }

  // A message handed over by the app (the commit that was just undone).
  $effect(() => {
    const d = app.workDraft;
    if (!d) return;
    untrack(() => {
      subject = d.subject;
      body = d.body;
      coauthors = d.coauthors.map(formatPerson);
      amend = false;
      typed = null;
      app.workDraft = null;
    });
  });

  async function commit() {
    if (!canCommit || app.busy) return;
    if (await app.op('commit', { subject, body, coauthors: people, amend })) {
      subject = '';
      body = '';
      coauthors = [];
      amend = false;
      typed = null;
      // Stay here while there's more to commit; otherwise show the new commit.
      if (!app.hasWork && app.repo?.head) app.select(app.repo.head);
    }
  }

  let confirmUndo = $state(false);
  function undoLast() {
    if (head?.pushed && !confirmUndo) {
      confirmUndo = true;
      setTimeout(() => (confirmUndo = false), 4000);
      return;
    }
    confirmUndo = false;
    app.uncommit();
  }

  function onFormKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 's' && selUnstaged) {
      e.preventDefault();
      run('stage');
    } else if (e.key === 'u' && selStaged) {
      e.preventDefault();
      run('unstage');
    } else if (e.key === 'Escape' && (selStaged || selUnstaged)) {
      [...Object.values(staged), ...Object.values(unstaged)].forEach((s) => s.clear());
    }
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="view">
  <div class="top">
    <h2>Uncommitted changes</h2>
    {#if app.repo}
      <span class="dim">
        {app.repo.work.staged} staged · {app.repo.work.unstaged} unstaged · {app.repo.work.untracked} untracked
      </span>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="meta" onkeydown={onFormKey}>
    <input class="subject" bind:value={subject} placeholder="Commit title" spellcheck="true" />
    <textarea class="body" bind:value={body} placeholder="Description" rows="2" spellcheck="true"></textarea>
    <div class="people">
      <span class="dim label">Co-authors</span>
      <Coauthors bind:value={coauthors} />
    </div>
    <div class="actions">
      <button class="primary" onclick={commit} disabled={!canCommit || app.busy}>
        <CheckIcon size={14} weight="bold" />
        {#if amend && head}
          Amend {shortSha(head)}
        {:else}
          Commit {work?.staged.files.length ? plural(work.staged.files.length, 'file') : ''}
        {/if}
        <kbd>{mod}↵</kbd>
      </button>
      <label class="amend" title="Fold what's staged into the last commit and replace its message">
        <input type="checkbox" checked={amend} onchange={toggleAmend} disabled={!head?.editable} />
        Amend last commit
      </label>
      {#if amend && head?.pushed}
        <span class="warn">Already pushed: amending it means force pushing.</span>
      {:else if !amend && work && !work.staged.files.length}
        <span class="dim">Stage some changes first.</span>
      {/if}
    </div>
    {#if head?.editable && !head.merge && !amend}
      <div class="last dim">
        Last commit <span class="mono sha">{shortSha(head)}</span>
        <span class="last-subject">{head.subject}</span> ·
        <button class="link" class:warn={confirmUndo} onclick={undoLast} disabled={app.busy}>
          {confirmUndo ? 'It was pushed. Click again to undo it' : 'Undo (keep changes)'}
        </button>
      </div>
    {/if}
  </div>

  {#if error}
    <p class="dim empty">{error}</p>
  {:else if work}
    <section>
      <div class="shead">
        <h3>Staged</h3>
        <span class="dim">{plural(work.staged.files.length, 'file')}</span>
        <span class="spacer"></span>
        {#if work.staged.files.length}
          <button onclick={() => run('unstage', true)} disabled={app.busy}><ArrowDownIcon size={13} /> Unstage all</button>
        {/if}
      </div>
      {#if work.staged.files.length}
        {#key work.staged.sha}
          <DiffView summary={work.staged} sel={staged} readonly={false} hint="Pick changes to unstage (u)." />
        {/key}
      {:else}
        <p class="dim empty">Nothing staged. Pick changes below and stage them (s).</p>
      {/if}
    </section>

    <section>
      <div class="shead">
        <h3>Unstaged</h3>
        <span class="dim">{plural(work.unstaged.files.length, 'file')}</span>
        <span class="spacer"></span>
        {#if work.unstaged.files.length}
          <button onclick={() => run('stage', true)} disabled={app.busy}><ArrowUpIcon size={13} /> Stage all</button>
        {/if}
      </div>
      {#if work.unstaged.files.length}
        {#key work.unstaged.sha}
          <DiffView summary={work.unstaged} sel={unstaged} readonly={false} hint="Pick changes to stage (s)." />
        {/key}
      {:else}
        <p class="dim empty">No unstaged changes.</p>
      {/if}
    </section>
  {:else}
    <p class="dim empty">Loading changes…</p>
  {/if}

  {#if selStaged || selUnstaged}
    <div class="bar">
      {#if selUnstaged}
        <button class="primary" onclick={() => run('stage')} disabled={app.busy}>
          <ArrowUpIcon size={14} /> Stage {plural(selUnstaged, 'change')} <kbd>s</kbd>
        </button>
      {/if}
      {#if selStaged}
        <button onclick={() => run('unstage')} disabled={app.busy}>
          <ArrowDownIcon size={14} /> Unstage {plural(selStaged, 'change')} <kbd>u</kbd>
        </button>
      {/if}
      <span class="spacer"></span>
      <button
        class="ghost"
        onclick={() => [...Object.values(staged), ...Object.values(unstaged)].forEach((s) => s.clear())}
        title="Clear selection (esc)"
      >
        <XIcon size={14} />
      </button>
    </div>
  {/if}
</div>

<style>
  .view {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .top {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 20px 0;
  }

  h2 {
    margin: 0;
    font-size: 16px;
    color: var(--color2);
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 20px 16px;
    border-bottom: 1px solid var(--border);
  }

  .subject {
    font-size: 15px;
    font-weight: 600;
    color: var(--color2);
    padding: 7px 10px;
  }

  .body {
    field-sizing: content;
    min-height: 52px;
    max-height: 40vh;
    line-height: 1.5;
    padding: 7px 10px;
  }

  .people {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    align-items: start;
  }

  .label {
    padding-top: 6px;
    font-size: 12px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .amend {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    cursor: pointer;
    user-select: none;
  }

  .amend input {
    accent-color: var(--theme);
    margin: 0;
  }

  .warn {
    color: var(--warn);
    font-size: 12px;
  }

  .last {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
    min-width: 0;
  }

  .last .sha {
    color: var(--theme);
  }

  .last-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }

  .link {
    background: none;
    padding: 0;
    color: var(--theme);
    font-size: 12px;
  }

  .link:hover:not(:disabled) {
    background: none;
    text-decoration: underline;
  }

  section {
    border-bottom: 1px solid var(--border);
  }

  .shead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 20px 0;
  }

  h3 {
    margin: 0;
    font-size: 13px;
    color: var(--color2);
  }

  .shead button {
    font-size: 12px;
    padding: 3px 8px;
  }

  .spacer {
    flex: 1;
  }

  .empty {
    padding: 8px 20px 18px;
    margin: 0;
  }

  .bar {
    position: sticky;
    bottom: 12px;
    margin: auto 16px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-radius: 6px;
    background: var(--bg2);
    box-shadow: var(--box-shadow), 0 8px 30px #0000002e;
    border: 1px solid var(--theme-mid);
    z-index: 5;
    animation: rise 0.12s ease-out;
  }

  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
</style>
