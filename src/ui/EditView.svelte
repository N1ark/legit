<script lang="ts">
  // A commit checked out to edit its files (a rebase stopped at it). The files are changed in an
  // editor; this shows what changed so far, and Finish amends it into the commit and replays the
  // commits after it (conflicts go to the conflict view), or Cancel puts everything back.
  import { Button, ConfirmButton, Kbd, Segmented, hasOverlay, matches, tooltip } from 'purr';
  import { ArrowCounterClockwiseRegular, CheckBold } from 'purr/glyphs';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary } from '../shared/types.ts';
  import DiffView from './DiffView.svelte';
  import { type DiffPosition, EDITING, app, shortSha } from './lib/app.svelte.ts';
  import { tip } from './lib/tip.ts';

  const edit = $derived(app.repo?.conflict?.edit ?? null);

  // The commit as finishing would make it (its diff, with the edits), or only the edits so far,
  // straight from the working tree. It opens where the commit's own view was.
  let show = $state<'whole' | 'edits'>('whole');
  let whole = $state.raw<DiffSummary | null>(null);
  let edits = $state.raw<DiffSummary | null>(null);
  let error = $state<string | null>(null);
  let diffView = $state<DiffView>();
  // Each new diff (on every edit, or switching what's shown) opens where the last one was.
  let at = $state.raw<DiffPosition | null>(app.takeDiffPosition(EDITING));
  const diff = $derived(show === 'whole' ? whole : edits);
  let loading = false;
  let again = false;
  async function load() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const get = (q: string): Promise<DiffSummary | { error: string }> => fetch(`/api/editing${q}`).then((r) => r.json());
      const [w, e] = await Promise.all([get('?whole=1'), get('')]);
      if ('error' in w || 'error' in e) error = 'error' in w ? w.error : (e as { error: string }).error;
      else {
        error = null;
        const next = { whole: w.sha !== whole?.sha ? w : whole, edits: e.sha !== edits?.sha ? e : edits };
        if ((show === 'whole' ? next.whole : next.edits) !== diff) at = diffView?.position() ?? at;
        whole = next.whole;
        edits = next.edits;
      }
    } finally {
      loading = false;
      if (again) {
        again = false;
        load();
      }
    }
  }

  function setShow(v: 'whole' | 'edits') {
    at = diffView?.position() ?? at;
    show = v;
  }

  // Derived, so a refresh that brings a new state but the same HEAD doesn't load the diffs again.
  const head = $derived(app.repo?.head);
  const editing = $derived(!!edit);
  $effect(() => {
    void app.workTick;
    void head;
    if (editing) load();
  });

  const sel = $derived(diff ? Object.fromEntries(diff.files.map((f) => [f.path, new SvelteSet<number>()])) : {});
  const SHOWN = 8;

  const finish = () => app.endEdit('editFinish', diffView?.position() ?? at);
  const cancel = () => app.endEdit('editCancel', diffView?.position() ?? at);

  function onWindowKey(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing && !hasOverlay() && !app.busy) {
      e.preventDefault();
      finish();
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if edit}
  <div class="view">
    <div class="top">
      <h2>Editing</h2>
      <span class="mono sha">{shortSha(edit.sha)}</span>
      <span class="subject" use:tooltip={edit.subject}>{edit.subject}</span>
    </div>

    <div class="meta">
      <p class="muted hint">
        Change files in your editor{edit.legit ? ', new ones included' : ''}; finishing amends them into this commit.
        {#if !edit.legit}
          Started outside legit: <span class="mono">git add</span> new files to include them.
        {/if}
      </p>

      {#if edit.pending.length}
        <div class="pending">
          <span class="muted label">Then replays</span>
          <ol>
            {#each edit.pending.slice(0, SHOWN) as p (p.sha)}
              <li><span class="mono sha">{shortSha(p.sha)}</span> <span class="subject">{p.subject}</span></li>
            {/each}
            {#if edit.pending.length > SHOWN}
              <li class="muted">and {edit.pending.length - SHOWN} more</li>
            {/if}
          </ol>
        </div>
      {/if}

      <div class="actions">
        <Button
          variant="primary"
          onclick={finish}
          disabled={app.busy}
          {@attach tip('Amend your changes into the commit (hooks run as usual), then replay the commits after it; a conflict stops for you to resolve')}
        >
          <CheckBold /> Finish editing <Kbd hint="⌘↩" />
        </Button>
        {#if edits?.files.length}
          <ConfirmButton
            confirmLabel="Click to cancel. Your edits are saved first"
            onconfirm={cancel}
            disabled={app.busy}
            {@attach tip('Put everything back as it was; your edits are saved under refs/legit/aborted first')}
          >
            <ArrowCounterClockwiseRegular /> Cancel
          </ConfirmButton>
        {:else}
          <Button onclick={cancel} disabled={app.busy} {@attach tip('Put everything back as it was')}>
            <ArrowCounterClockwiseRegular /> Cancel
          </Button>
        {/if}
        <span class="spacer"></span>
        <Segmented
          label="What the diff shows"
          size="sm"
          options={[
            { id: 'whole', label: 'Whole commit' },
            { id: 'edits', label: edits?.files.length ? `Your edits (${edits.files.length})` : 'Your edits' },
          ]}
          bind:value={() => show, setShow}
        />
      </div>
    </div>

    {#if error}
      <p class="muted empty">{error}</p>
    {:else if !diff}
      <p class="muted empty">Loading changes…</p>
    {:else if !diff.files.length}
      <p class="muted empty">{show === 'edits' ? 'No edits yet.' : 'Empty commit.'}</p>
    {:else}
      {#key diff.sha}
        <DiffView bind:this={diffView} summary={diff} {sel} readonly={true} initial={at} />
      {/key}
    {/if}
  </div>
{/if}

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
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-xl);
    color: var(--color2);
    flex-shrink: 0;
  }

  .sha {
    color: var(--theme2);
    flex-shrink: 0;
  }

  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .top .subject {
    font-size: var(--fs-lg);
    font-weight: 600;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--sp-4) var(--sp-5) var(--sp-5);
    border-bottom: 1px solid var(--border);
  }

  p {
    margin: 0;
  }

  .hint {
    font-size: var(--fs-sm);
    line-height: 1.5;
  }

  .pending {
    display: flex;
    gap: var(--sp-4);
    font-size: var(--fs-sm);
  }

  .label {
    flex-shrink: 0;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    min-width: 0;
  }

  li {
    display: flex;
    gap: var(--gap-3);
    min-width: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }

  .empty {
    padding: var(--sp-5);
  }

  .spacer {
    flex: 1;
  }
</style>
