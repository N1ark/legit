<script lang="ts">
  // Uncommitted changes: a commit form, and each file's changes from HEAD to the working tree.
  // What's picked in them is what's staged: picking a line, block or file stages or unstages
  // it right away (only the index changes). Discarding is in the menus.
  import { Button, Checkbox, ConfirmButton, Kbd, hasOverlay, matches, toast, tooltip } from 'purr';
  import { ArrowDown, ArrowUp, Check, Trash } from 'purr/icons';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary, FileSummary, OpResult, Selection, WorkState } from '../shared/types.ts';
  import Coauthors from './Coauthors.svelte';
  import DiffView from './DiffView.svelte';
  import { app, request, shortSha } from './lib/app.svelte.ts';
  import { discardChanges } from './lib/discard.ts';
  import { formatPerson, parsePeople } from './lib/people.ts';
  import { refComplete } from './gh/ref-complete.svelte.ts';
  import { tip } from './lib/tip.ts';

  type Sel = Record<string, SvelteSet<number>>;
  let work = $state.raw<WorkState | null>(null);
  let staged = $state<Sel>({});
  let error = $state<string | null>(null);

  const stagedSel = (d: DiffSummary): Sel => Object.fromEntries(d.files.map((f) => [f.path, new SvelteSet<number>(f.staged ?? [])]));

  let loading = false;
  let again = false;
  /** The response `work` was made from. */
  let shown: string | null = null;
  /** Show what's staged again even if the snapshot is the same (a pick failed). */
  let resync = false;
  async function load() {
    // While picks are still on their way, what's shown is ahead of the index: load once they're in.
    if (loading || pending) {
      again = true;
      return;
    }
    loading = true;
    try {
      const res = await fetch('/api/work');
      const text = await res.text();
      const w: WorkState | { error: string } = JSON.parse(text);
      if ('error' in w) {
        error = w.error;
        shown = null;
      } else if (!pending) {
        error = null;
        if (resync || w.changes.sha !== work?.changes.sha) staged = stagedSel(w.changes);
        resync = false;
        // The same answer again (most refreshes change nothing here) has nothing to redraw.
        if (text !== shown) [work, shown] = [w, text];
      } else again = true;
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

  // Picks are sent one after the other, each as soon as it's made, against the snapshot they
  // were made on (the server refuses a file that changed since; what's staged may have).
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  function stage(path: string, lines: number[] | 'all', on: boolean) {
    stageMany({ [path]: lines }, on);
  }

  function stageMany(selection: Selection, on: boolean) {
    if (!work || !Object.keys(selection).length) return;
    const key = work.changes.sha;
    pending++;
    queue = queue.then(async () => {
      try {
        await request<OpResult>(on ? '/api/stage' : '/api/unstage', { key, selection });
      } catch (e) {
        toast.error(e);
        resync = true;
      } finally {
        if (--pending === 0) {
          app.refresh();
          load();
        }
      }
    });
  }

  const all = (files: FileSummary[]): Selection => Object.fromEntries(files.map((f) => [f.path, 'all']));
  const isStaged = (f: FileSummary) => !!staged[f.path]?.size || !!f.unshown || !!f.mixed?.length;
  const stagedFiles = $derived(work ? work.changes.files.filter(isStaged).length : 0);
  const unstagedFiles = $derived(
    work ? work.changes.files.filter((f) => f.unshown || f.mixed?.length || (staged[f.path]?.size ?? 0) < Math.max(1, f.added + f.removed)) : [],
  );

  function stageAll(on: boolean) {
    if (!work) return;
    const files = on ? unstagedFiles : work.changes.files.filter(isStaged);
    for (const f of files) {
      const s = staged[f.path];
      if (on) for (let k = 0; k < Math.max(1, f.added + f.removed); k++) s.add(k);
      else s.clear();
    }
    stageMany(all(files), on);
  }

  // Discarding saves what it throws away first (refs/legit/discarded); the toast can undo it.
  // Staged changes go out of the index as well as the files.
  async function discard(selection: Selection) {
    if (!work || app.busy) return;
    await queue;
    await discardChanges(work.changes.sha, selection);
    await load();
  }

  // Commit form, as it was left if the window has shown this repo before.
  type Kept = { subject: string; body: string; coauthors: string[]; amend: boolean; typed: typeof typed };
  const back = app.restore<Kept>('work');
  let subject = $state(back?.subject ?? '');
  let body = $state(back?.body ?? '');
  let coauthors = $state<string[]>(back?.coauthors ?? []);
  const people = $derived(parsePeople(coauthors));
  const head = $derived(app.commits.find((c) => c.sha === app.repo?.head) ?? null);
  let amend = $state(back?.amend ?? false);
  const canCommit = $derived(
    subject.trim() !== '' && people !== null && !app.repo?.blocked && (amend ? !!head : stagedFiles > 0),
  );

  // Amending starts from the last commit's message; turning it off brings back what was typed.
  let typed: { subject: string; body: string; coauthors: string[] } | null = back?.typed ?? null;
  $effect(() => app.keep('work', (): Kept => ({ subject, body, coauthors, amend, typed })));
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
    await queue;
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

  function onWindowKey(e: KeyboardEvent) {
    // ⌘↩ commits wherever the focus is, so picking changes in the diff doesn't need a click back.
    if (matches('⌘↩', e) && !e.isComposing && !hasOverlay()) {
      e.preventDefault();
      commit();
    }
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="view">
  <div class="top">
    <h2>Uncommitted changes</h2>
  </div>

  <div class="meta">
    <input class="field-input subject" bind:value={subject} placeholder="Commit title" spellcheck="true" {@attach refComplete} />
    <textarea class="field-input body" bind:value={body} placeholder="Description" rows="2" spellcheck="true" {@attach refComplete}></textarea>
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
          Commit {stagedFiles ? plural(stagedFiles, 'file') : ''}
        {/if}
        <Kbd hint="⌘↩" />
      </Button>
      <span use:tooltip={"Fold what's staged into the last commit and replace its message"}>
        <Checkbox label="Amend last commit" checked={amend} onchange={toggleAmend} disabled={!head?.editable} />
      </span>
      {#if amend && head?.pushed}
        <span class="warn">Pushed: amending means force pushing</span>
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
            disabled={app.busy}
            {@attach tip('Undo it; its changes stay staged')}>Undo</ConfirmButton
          >
        {:else}
          <Button variant="link" onclick={() => app.uncommit()} disabled={app.busy} {@attach tip('Undo it; its changes stay staged')}>Undo</Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if error}
    <p class="muted empty">{error}</p>
  {:else if work}
    {@const files = work.changes.files}
    <section>
      <div class="shead">
        <h3>Changes</h3>
        <span class="muted">{plural(files.length, 'file')} · {stagedFiles} staged</span>
        <span class="spacer"></span>
        {#if files.length}
          <ConfirmButton
            variant="ghost"
            confirmLabel="Discard all {plural(files.length, 'file')}? Click again"
            onconfirm={() => discard(all(files))}
            disabled={app.busy}
            {@attach tip('Throw away every uncommitted change, untracked files included; saved first, so it can be restored')}
            ><Trash /> Discard all</ConfirmButton
          >
          <Button onclick={() => stageAll(false)} disabled={!stagedFiles}><ArrowDown /> Unstage all</Button>
          <Button onclick={() => stageAll(true)} disabled={!unstagedFiles.length}><ArrowUp /> Stage all</Button>
        {/if}
      </div>
      {#if files.length}
        {#key work.content}
          <DiffView
            summary={work.changes}
            sel={staged}
            readonly={false}
            hint="Checked lines are staged"
            help="Click a line, the strip beside a block, or a file's box; drag down the line numbers for several. Right-click to discard."
            onstage={stage}
            changeActions={(f, line, block) => [
              {
                label: 'Discard this change',
                icon: Trash,
                danger: true,
                confirm: 'Click again to discard',
                note: 'From your file, and the index if staged. It can be restored.',
                run: () => discard({ [f.path]: line }),
              },
              block.length > line.length && {
                label: `Discard these ${block.length} changes`,
                icon: Trash,
                danger: true,
                confirm: 'Click again to discard',
                note: 'The block around this line. It can be restored.',
                run: () => discard({ [f.path]: block }),
              },
              'separator',
            ]}
            fileActions={(f) => [
              {
                label: "Discard this file's changes",
                icon: Trash,
                danger: true,
                confirm: 'Click again to discard',
                note: f.untracked ? 'Deletes the file. It can be restored.' : 'Back to the last commit, index included. It can be restored.',
                run: () => discard({ [f.path]: 'all' }),
              },
            ]}
          />
        {/key}
      {:else}
        <p class="muted empty">No changes.</p>
      {/if}
    </section>
  {:else}
    <p class="muted empty">Loading changes…</p>
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
</style>
