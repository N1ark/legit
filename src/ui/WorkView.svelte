<script lang="ts">
  // Uncommitted changes: a commit form, what's staged, and what isn't (untracked files
  // included). Select lines like in a commit and stage/unstage them; only the index changes.
  import { Button, Checkbox, ConfirmButton, IconButton, Kbd, hasOverlay, isTyping, matches } from 'purr';
  import { ArrowDown, ArrowUp, Check, X } from 'purr/icons';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary, Selection, WorkState } from '../shared/types.ts';
  import Coauthors from './Coauthors.svelte';
  import DiffView from './DiffView.svelte';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { formatPerson, parsePeople } from './lib/people.ts';

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

  function onFormKey(e: KeyboardEvent) {
    if (matches('⌘↩', e)) {
      e.preventDefault();
      commit();
    }
  }

  const clear = () => [...Object.values(staged), ...Object.values(unstaged)].forEach((s) => s.clear());

  function onWindowKey(e: KeyboardEvent) {
    if (isTyping(e.target) || hasOverlay()) return;
    if (matches('s', e) && selUnstaged) {
      e.preventDefault();
      run('stage');
    } else if (matches('u', e) && selStaged) {
      e.preventDefault();
      run('unstage');
    } else if (e.key === 'Escape' && (selStaged || selUnstaged)) {
      clear();
    }
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="view">
  <div class="top">
    <h2>Uncommitted changes</h2>
    {#if app.repo}
      <span class="muted">
        {app.repo.work.staged} staged · {app.repo.work.unstaged} unstaged · {app.repo.work.untracked} untracked
      </span>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="meta" onkeydown={onFormKey}>
    <input class="field-input subject" bind:value={subject} placeholder="Commit title" spellcheck="true" />
    <textarea class="field-input body" bind:value={body} placeholder="Description" rows="2" spellcheck="true"></textarea>
    <div class="people">
      <span class="muted label">Co-authors</span>
      <Coauthors bind:value={coauthors} />
    </div>
    <div class="actions">
      <Button variant="primary" onclick={commit} disabled={!canCommit || app.busy}>
        <Check weight="bold" />
        {#if amend && head}
          Amend {shortSha(head)}
        {:else}
          Commit {work?.staged.files.length ? plural(work.staged.files.length, 'file') : ''}
        {/if}
        <Kbd hint="⌘↩" />
      </Button>
      <span title="Fold what's staged into the last commit and replace its message">
        <Checkbox label="Amend last commit" checked={amend} onchange={toggleAmend} disabled={!head?.editable} />
      </span>
      {#if amend && head?.pushed}
        <span class="warn">Already pushed: amending it means force pushing.</span>
      {:else if !amend && work && !work.staged.files.length}
        <span class="muted">Stage some changes first.</span>
      {/if}
    </div>
    {#if head?.editable && !head.merge && !amend}
      <div class="last muted">
        Last commit <span class="mono sha">{shortSha(head)}</span>
        <span class="last-subject">{head.subject}</span> ·
        {#if head.pushed}
          <ConfirmButton
            variant="link"
            confirmLabel="It was pushed. Click again to undo it"
            onconfirm={() => app.uncommit()}
            disabled={app.busy}>Undo (keep changes)</ConfirmButton
          >
        {:else}
          <Button variant="link" onclick={() => app.uncommit()} disabled={app.busy}>Undo (keep changes)</Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if error}
    <p class="muted empty">{error}</p>
  {:else if work}
    <section>
      <div class="shead">
        <h3>Staged</h3>
        <span class="muted">{plural(work.staged.files.length, 'file')}</span>
        <span class="spacer"></span>
        {#if work.staged.files.length}
          <Button onclick={() => run('unstage', true)} disabled={app.busy}><ArrowDown /> Unstage all</Button>
        {/if}
      </div>
      {#if work.staged.files.length}
        {#key work.staged.sha}
          <DiffView summary={work.staged} sel={staged} readonly={false} hint="Pick changes to unstage (u)." />
        {/key}
      {:else}
        <p class="muted empty">Nothing staged. Pick changes below and stage them (s).</p>
      {/if}
    </section>

    <section>
      <div class="shead">
        <h3>Unstaged</h3>
        <span class="muted">{plural(work.unstaged.files.length, 'file')}</span>
        <span class="spacer"></span>
        {#if work.unstaged.files.length}
          <Button onclick={() => run('stage', true)} disabled={app.busy}><ArrowUp /> Stage all</Button>
        {/if}
      </div>
      {#if work.unstaged.files.length}
        {#key work.unstaged.sha}
          <DiffView summary={work.unstaged} sel={unstaged} readonly={false} hint="Pick changes to stage (s)." />
        {/key}
      {:else}
        <p class="muted empty">No unstaged changes.</p>
      {/if}
    </section>
  {:else}
    <p class="muted empty">Loading changes…</p>
  {/if}

  {#if selStaged || selUnstaged}
    <div class="bar">
      {#if selUnstaged}
        <Button variant="primary" onclick={() => run('stage')} disabled={app.busy}>
          <ArrowUp /> Stage {plural(selUnstaged, 'change')} <Kbd hint="s" />
        </Button>
      {/if}
      {#if selStaged}
        <Button onclick={() => run('unstage')} disabled={app.busy}>
          <ArrowDown /> Unstage {plural(selStaged, 'change')} <Kbd hint="u" />
        </Button>
      {/if}
      <span class="spacer"></span>
      <IconButton label="Clear selection" shortcut="Esc" onclick={clear}><X /></IconButton>
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
    gap: var(--sp-4);
    padding: var(--sp-5) var(--sp-5) 0;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-xl);
    color: var(--color2);
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--sp-4) var(--sp-5) var(--sp-5);
    border-bottom: 1px solid var(--border);
  }

  .subject {
    font-size: var(--fs-xl);
    font-weight: 600;
    padding: var(--sp-3) var(--sp-4);
  }

  .body {
    field-sizing: content;
    min-height: 52px;
    max-height: 40vh;
    font-size: var(--fs-base);
    line-height: 1.5;
    padding: var(--sp-3) var(--sp-4);
  }

  .people {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--gap-3) var(--sp-4);
    align-items: start;
  }

  .label {
    padding-top: var(--gap-3);
    font-size: var(--fs-sm);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }

  .warn {
    color: var(--warn);
    font-size: var(--fs-sm);
  }

  .last {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    font-size: var(--fs-sm);
    min-width: 0;
  }

  .last .sha {
    color: var(--theme2);
  }

  .last-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }

  section {
    border-bottom: 1px solid var(--border);
  }

  .shead {
    display: flex;
    align-items: baseline;
    gap: var(--sp-4);
    padding: var(--sp-5) var(--sp-5) 0;
  }

  h3 {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color2);
  }

  .spacer {
    flex: 1;
  }

  .empty {
    padding: var(--gap-4) var(--sp-5) var(--sp-5);
    margin: 0;
  }

  .bar {
    position: sticky;
    bottom: var(--sp-4);
    margin: auto var(--sp-5) var(--sp-4);
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    padding: var(--gap-4);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--theme-mid);
    z-index: var(--z-sticky);
    animation: rise var(--dur) var(--ease);
  }

  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
</style>
