<script lang="ts">
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
  import ArrowUUpLeftIcon from 'phosphor-svelte/lib/ArrowUUpLeftIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import CloudCheckIcon from 'phosphor-svelte/lib/CloudCheckIcon';
  import ScissorsIcon from 'phosphor-svelte/lib/ScissorsIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { CommitInfo, DiffSummary, Selection } from '../shared/types.ts';
  import Avatar from './Avatar.svelte';
  import Coauthors from './Coauthors.svelte';
  import DiffView from './DiffView.svelte';
  import { formatPerson, parsePeople } from './lib/people.ts';
  import { app, shortSha } from './lib/app.svelte.ts';

  let { commit }: { commit: CommitInfo } = $props();

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';
  const fmt = formatPerson;

  // Metadata form, initialised from the commit (the view is re-created when the commit changes).
  const init = untrack(() => commit);
  let subject = $state(init.subject);
  let body = $state(init.body);
  let authorName = $state(init.author.name);
  let authorEmail = $state(init.author.email);
  let coauthors = $state(init.coauthors.map(fmt));

  const readonly = $derived(!commit.editable || !!app.repo?.blocked);
  const parsedCo = $derived(parsePeople(coauthors));
  const valid = $derived(subject.trim() !== '' && parsedCo !== null);
  const dirty = $derived(
    subject !== commit.subject ||
      body !== commit.body ||
      authorName !== commit.author.name ||
      authorEmail !== commit.author.email ||
      coauthors.filter((s) => s.trim()).join('\n') !== commit.coauthors.map(fmt).join('\n'),
  );

  function save() {
    if (!dirty || !valid || readonly) return;
    app.op('edit', {
      sha: commit.sha,
      subject,
      body,
      author: { name: authorName, email: authorEmail },
      coauthors: parsedCo ?? [],
    });
  }

  function revert() {
    subject = commit.subject;
    body = commit.body;
    authorName = commit.author.name;
    authorEmail = commit.author.email;
    coauthors = commit.coauthors.map(fmt);
  }

  // Diff + split selection.
  let diff = $state.raw<DiffSummary | null>(null);
  let sel = $state<Record<string, SvelteSet<number>>>({});
  let splitMessage = $state('');
  let before = $state(false);

  // A new commit starts at the top.
  onMount(() => {
    const scroller = document.querySelector('[data-scroller]');
    if (scroller) scroller.scrollTop = 0;
  });

  app.diff(init.sha).then(
    (d) => {
      sel = Object.fromEntries(d.files.map((f) => [f.path, new SvelteSet<number>()]));
      diff = d;
    },
    (e) => app.toast(e.message, 'error'),
  );

  const picked = $derived.by(() => {
    let lines = 0;
    let files = 0;
    for (const s of Object.values(sel)) {
      if (s.size) files++;
      lines += s.size;
    }
    return { lines, files };
  });

  function selection(): Selection {
    const out: Selection = {};
    for (const f of diff?.files ?? []) {
      const s = sel[f.path];
      const n = f.added + f.removed;
      if (!s?.size) continue;
      out[f.path] = n === 0 || s.size === n ? 'all' : [...s];
    }
    return out;
  }

  function split() {
    if (!picked.files || !splitMessage.trim() || readonly) return;
    app.op('split', { sha: commit.sha, selection: selection(), message: splitMessage, before });
  }

  let confirmDrop = $state(false);
  let dropTimer: ReturnType<typeof setTimeout>;
  function dropCommit() {
    if (!confirmDrop) {
      confirmDrop = true;
      dropTimer = setTimeout(() => (confirmDrop = false), 3000);
      return;
    }
    clearTimeout(dropTimer);
    app.op('drop', { shas: [commit.sha] });
  }

  const isHead = $derived(commit.sha === app.repo?.head);
  let confirmUndo = $state(false);
  function undoCommit() {
    if (commit.pushed && !confirmUndo) {
      confirmUndo = true;
      setTimeout(() => (confirmUndo = false), 4000);
      return;
    }
    confirmUndo = false;
    app.uncommit();
  }

  function copySha() {
    navigator.clipboard.writeText(commit.sha).then(() => app.toast(`Copied ${shortSha(commit)}`));
  }

  function onFormKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape' && dirty) {
      e.preventDefault();
      revert();
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && picked.files && !(e.target as HTMLElement).closest('input, textarea')) {
      Object.values(sel).forEach((s) => s.clear());
    }
  }

  function onSplitKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      split();
    }
  }

  const date = new Date(init.author.time * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="view">
  <div class="top">
    <button class="ghost sha mono" onclick={copySha} title="Copy full SHA">{shortSha(commit)}</button>
    <span class="dim">{date}</span>
    {#if commit.pushed}
      <span class="tag" title="This commit is on a remote branch; rewriting it means you'll need to force-push.">
        <CloudCheckIcon size={13} /> pushed
      </span>
    {/if}
    <span class="spacer"></span>
    {#if !readonly && isHead && !commit.merge}
      <button class="ghost undo" class:confirm={confirmUndo} onclick={undoCommit} disabled={app.busy} title="Undo this commit; its changes stay staged">
        <ArrowUUpLeftIcon size={15} />
        <span>{confirmUndo ? 'It was pushed. Click again' : 'Undo commit'}</span>
      </button>
    {/if}
    {#if !readonly}
      <button class="ghost danger" class:confirm={confirmDrop} onclick={dropCommit} disabled={app.busy} title="Drop this commit">
        <TrashIcon size={15} />{#if confirmDrop}<span>Click again to drop</span>{/if}
      </button>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="meta" onkeydown={onFormKey}>
    <input class="subject" bind:value={subject} placeholder="Commit title" disabled={readonly} spellcheck="true" />
    <textarea class="body" bind:value={body} placeholder="Description" disabled={readonly} rows="3" spellcheck="true"></textarea>

    <div class="people">
      <label for="author-name" class="dim">Author</label>
      <div class="person">
        <Avatar email={authorEmail} name={authorName} size={22} />
        <input id="author-name" bind:value={authorName} placeholder="Name" disabled={readonly} />
        <input bind:value={authorEmail} placeholder="email@example.com" disabled={readonly} class="mono" />
      </div>

      <span class="dim label">Co-authors</span>
      <Coauthors bind:value={coauthors} {readonly} />
    </div>

    {#if dirty && !readonly}
      <div class="actions">
        <button class="primary" onclick={save} disabled={!valid || app.busy}>
          <CheckIcon size={14} weight="bold" /> Save <kbd>{mod}↵</kbd>
        </button>
        <button onclick={revert}><ArrowCounterClockwiseIcon size={14} /> Revert <kbd>esc</kbd></button>
      </div>
    {/if}
  </div>

  {#if diff}
    <DiffView summary={diff} {sel} {readonly} />
  {:else}
    <p class="dim loading">Loading diff…</p>
  {/if}

  {#if picked.files && !readonly}
    <div class="split">
      <ScissorsIcon size={16} />
      <span class="count">
        Split <b>{picked.lines || picked.files}</b>
        {picked.lines ? (picked.lines === 1 ? 'change' : 'changes') : picked.files === 1 ? 'file' : 'files'}
        into a new commit
      </span>
      <div class="seg" role="radiogroup">
        <button class:on={before} onclick={() => (before = true)} role="radio" aria-checked={before}>before</button>
        <button class:on={!before} onclick={() => (before = false)} role="radio" aria-checked={!before}>after</button>
      </div>
      <input
        class="msg"
        bind:value={splitMessage}
        placeholder="New commit title"
        onkeydown={onSplitKey}
      />
      <button class="primary" onclick={split} disabled={!splitMessage.trim() || app.busy}>Split <kbd>↵</kbd></button>
      <button class="ghost" onclick={() => Object.values(sel).forEach((s) => s.clear())} title="Clear selection (esc)">
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
    align-items: center;
    gap: 10px;
    padding: 10px 20px 0 14px;
  }

  .sha {
    color: var(--theme);
    font-size: 12px;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--warn);
  }

  .spacer {
    flex: 1;
  }

  .undo {
    font-size: 12px;
    color: var(--dim);
  }

  .undo:hover:not(:disabled) {
    color: var(--color2);
  }

  .confirm {
    color: var(--del);
    background: var(--del-bg);
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 20px 16px;
    border-bottom: 1px solid var(--border);
  }

  .subject {
    font-size: 16px;
    font-weight: 600;
    color: var(--color2);
    padding: 7px 10px;
  }

  .body {
    field-sizing: content;
    min-height: 60px;
    max-height: 50vh;
    line-height: 1.5;
    padding: 7px 10px;
  }

  input:disabled,
  textarea:disabled {
    background: transparent;
    border-color: transparent;
    color: inherit;
    opacity: 1;
  }

  .people {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    align-items: start;
  }

  .people > label,
  .people > .label {
    padding-top: 6px;
    font-size: 12px;
  }

  .person {
    display: grid;
    grid-template-columns: auto 1fr 1.2fr;
    align-items: center;
    gap: 6px;
  }

  .actions {
    display: flex;
    gap: 6px;
  }

  .loading {
    padding: 20px;
  }

  .split {
    position: sticky;
    bottom: 12px;
    margin: auto 16px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 14px;
    border-radius: 6px;
    background: var(--bg2);
    box-shadow: var(--box-shadow), 0 8px 30px #0000002e;
    border: 1px solid var(--theme-mid);
    color: var(--theme);
    animation: rise 0.12s ease-out;
    z-index: 5;
  }

  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }

  .count {
    color: var(--color);
    white-space: nowrap;
  }

  .seg {
    display: flex;
    background: var(--bg3);
    border-radius: 4px;
    padding: 2px;
  }

  .seg button {
    background: none;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--dim);
  }

  .seg button.on {
    background: var(--bg);
    color: var(--color2);
    box-shadow: var(--box-shadow);
  }

  .msg {
    flex: 1;
    color: var(--color2);
  }
</style>
