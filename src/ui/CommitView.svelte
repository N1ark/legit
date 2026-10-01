<script lang="ts">
  import { Avatar, Button, ConfirmButton, IconButton, Kbd, Segmented, Tag, formatAbsolute, hasOverlay, isTyping, matches, toast } from 'purr';
  import { ArrowCounterClockwise, ArrowUUpLeft, Check, CloudCheck, Eraser, GitMerge, Scissors, Trash, X } from 'purr/icons';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { CommitInfo, DiffSummary, Selection } from '../shared/types.ts';
  import Coauthors from './Coauthors.svelte';
  import DiffView from './DiffView.svelte';
  import Markdown from './Markdown.svelte';
  import { formatPerson, parsePeople } from './lib/people.ts';
  import { app, avatarUrl, shortSha } from './lib/app.svelte.ts';

  let { commit }: { commit: CommitInfo } = $props();

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

  // Title and description show rendered, and turn into fields to edit them (on a click, or Tab).
  let editing = $state<'subject' | 'body' | null>(null);

  function edit(field: 'subject' | 'body') {
    if (!readonly) editing = field;
  }

  /** A click on a link follows it rather than starting to edit. */
  function keepLinks(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) e.preventDefault();
  }

  function focusEnd(el: HTMLInputElement | HTMLTextAreaElement) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

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
  let where = $state<'before' | 'after'>('after');

  // A new commit starts at the top; one rewritten from its own diff, where the old one was.
  const position = app.takeDiffPosition(init.sha);
  let diffView = $state<DiffView>();
  onMount(() => {
    const scroller = document.querySelector('[data-scroller]');
    if (scroller && !position) scroller.scrollTop = 0;
  });

  app.diff(init.sha).then(
    (d) => {
      sel = Object.fromEntries(d.files.map((f) => [f.path, new SvelteSet<number>()]));
      diff = d;
    },
    (e) => toast.error(e),
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
    app.op('split', { sha: commit.sha, selection: selection(), message: splitMessage, before: where === 'before' });
  }

  /**
   * Take changes out of this commit (and so out of the commits after it, and your files).
   * It's undoable like any rewrite; the toast says so.
   */
  async function remove(selection: Selection) {
    const n = Object.values(selection).reduce((k, v) => k + (v === 'all' ? 1 : v.length), 0);
    if (!n || readonly) return;
    const what = Object.values(selection).some((v) => v === 'all') ? 'changes' : n === 1 ? 'a change' : `${n} changes`;
    const { sha, subject } = commit;
    if (await app.editDiff('removeChanges', { sha, selection }, diffView?.position() ?? null)) {
      // Undoing brings this commit back, so show it again rather than the newest one.
      const undo = async () => (await app.undo()) && app.select(sha);
      toast(`Removed ${what} from "${subject}".`, { timeout: 8000, action: { label: 'Undo', run: undo } });
    }
  }

  function editLine(path: string, line: number, text: string) {
    return app.editDiff('editLine', { sha: commit.sha, path, line, text }, diffView?.position() ?? null);
  }

  const clear = () => Object.values(sel).forEach((s) => s.clear());
  const isHead = $derived(commit.sha === app.repo?.head);

  async function copySha() {
    await app.copy(commit.sha, shortSha(commit));
  }

  function onFormKey(e: KeyboardEvent) {
    if (matches('⌘↩', e)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape' && dirty) {
      e.preventDefault();
      revert();
    } else if (e.key === 'Escape' && editing) {
      e.preventDefault();
      editing = null;
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    if (!picked.files || isTyping(e.target) || hasOverlay()) return;
    if (e.key === 'Escape') clear();
    else if ((e.key === 'Backspace' || e.key === 'Delete') && !readonly) {
      e.preventDefault();
      remove(selection());
    }
  }

  function onSplitKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      split();
    }
  }

  const date = formatAbsolute(init.author.time * 1000);
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="view">
  <div class="top">
    <button class="btn btn--ghost sha mono" onclick={copySha} title="Copy full SHA">{shortSha(commit)}</button>
    <span class="muted">{date}</span>
    {#if commit.pushed}
      <Tag color="var(--warn)" title="This commit is on a remote branch; rewriting it means you'll need to force-push.">
        <span class="tag-icon"><CloudCheck /> pushed</span>
      </Tag>
    {/if}
    <span class="spacer"></span>
    {#if commit.merge && !commit.side}
      {@const open = commit.sha in app.expanded}
      <Button variant="ghost" onclick={() => app.toggleMerge(commit.sha)} title="List the commits it brought in under it (→ / ←)">
        <GitMerge /> {open ? 'Hide' : 'Show'} merged commits
      </Button>
    {/if}
    {#if !readonly && isHead && !commit.merge}
      {#if commit.pushed}
        <ConfirmButton
          variant="ghost"
          confirmLabel="It was pushed. Click again"
          onconfirm={() => app.uncommit()}
          disabled={app.busy}
          title="Undo this commit; its changes stay staged"
        >
          <ArrowUUpLeft /> Undo commit
        </ConfirmButton>
      {:else}
        <Button variant="ghost" onclick={() => app.uncommit()} disabled={app.busy} title="Undo this commit; its changes stay staged">
          <ArrowUUpLeft /> Undo commit
        </Button>
      {/if}
    {/if}
    {#if !readonly}
      <ConfirmButton
        variant="ghost"
        class="btn--danger"
        timeout={3000}
        confirmLabel="Click again to drop"
        onconfirm={() => app.op('drop', { shas: [commit.sha] })}
        disabled={app.busy}
        title="Drop this commit"
        aria-label="Drop this commit"
      >
        <span class="glyph"><Trash /></span>
      </ConfirmButton>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="meta" onkeydown={onFormKey}>
    {#if editing === 'subject'}
      <input
        class="field-input subject"
        bind:value={subject}
        placeholder="Commit title"
        spellcheck="true"
        onblur={() => editing === 'subject' && (editing = null)}
        {@attach focusEnd}
      />
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="field-input subject shown"
        class:readonly
        tabindex={readonly ? undefined : 0}
        title={readonly ? undefined : 'Click to edit'}
        onfocus={() => edit('subject')}
        onmousedown={keepLinks}
      >
        {#if subject}<Markdown text={subject} inline />{:else}<span class="placeholder">Commit title</span>{/if}
      </div>
    {/if}
    {#if editing === 'body'}
      <textarea
        class="field-input body"
        bind:value={body}
        placeholder="Description"
        rows="3"
        spellcheck="true"
        onblur={() => editing === 'body' && (editing = null)}
        {@attach focusEnd}
      ></textarea>
    {:else if body.trim() || !readonly}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="field-input body shown"
        class:readonly
        tabindex={readonly ? undefined : 0}
        title={readonly ? undefined : 'Click to edit'}
        onfocus={() => edit('body')}
        onmousedown={keepLinks}
      >
        {#if body.trim()}<Markdown text={body} />{:else}<span class="placeholder">Description</span>{/if}
      </div>
    {/if}

    <div class="people">
      <label for="author-name" class="muted">Author</label>
      <div class="person">
        <Avatar name={authorName || '?'} src={avatarUrl(authorEmail, 22)} seed={authorEmail.toLowerCase()} size={22} round />
        <input class="field-input" id="author-name" bind:value={authorName} placeholder="Name" disabled={readonly} />
        <input class="field-input mono" bind:value={authorEmail} placeholder="email@example.com" disabled={readonly} />
      </div>

      <span class="muted label">Co-authors</span>
      <Coauthors bind:value={coauthors} {readonly} />
    </div>

    {#if dirty && !readonly}
      <div class="actions">
        <Button variant="primary" onclick={save} disabled={!valid || app.busy}>
          <Check weight="bold" /> Save <Kbd hint="⌘↩" />
        </Button>
        <Button onclick={revert}><ArrowCounterClockwise /> Revert <Kbd hint="Esc" /></Button>
      </div>
    {/if}
  </div>

  {#if diff}
    <DiffView
      bind:this={diffView}
      summary={diff}
      {sel}
      {readonly}
      tree
      initial={position}
      hint="Pick lines to split out or remove: click, drag, or shift-click; the left edge picks whole blocks. Double-click a line to edit it."
      onremove={remove}
      oneditline={editLine}
      fileActions={(f) => [
        !readonly && {
          label: 'Remove file from commit',
          icon: Eraser,
          note: f.status === 'A' ? "The file won't be added" : f.status === 'D' ? 'The file stays' : 'It goes back to how it was before',
          run: () => remove({ [f.path]: 'all' }),
        },
      ]}
    />
  {:else}
    <p class="muted loading">Loading diff…</p>
  {/if}

  {#if picked.files && !readonly}
    <div class="split">
      <Scissors />
      <span class="count">
        Split <b>{picked.lines || picked.files}</b>
        {picked.lines ? (picked.lines === 1 ? 'change' : 'changes') : picked.files === 1 ? 'file' : 'files'}
        into a new commit
      </span>
      <Segmented
        label="Where the new commit goes"
        size="sm"
        options={[
          { id: 'before', label: 'before' },
          { id: 'after', label: 'after' },
        ]}
        bind:value={where}
      />
      <input class="field-input msg" bind:value={splitMessage} placeholder="New commit title" onkeydown={onSplitKey} />
      <Button variant="primary" onclick={split} disabled={!splitMessage.trim() || app.busy}>Split <Kbd hint="↩" /></Button>
      <Button
        onclick={() => remove(selection())}
        disabled={app.busy}
        title="Take these changes out of the commit: added lines aren't added, removed lines stay. The commits after it, and your files, lose them too."
      >
        <Eraser /> Remove <Kbd hint="⌫" />
      </Button>
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
    align-items: center;
    gap: var(--sp-4);
    padding: var(--sp-4) var(--sp-5) 0 var(--sp-5);
  }

  .sha {
    margin-left: calc(-1 * var(--sp-3));
    color: var(--theme2);
  }

  .spacer {
    flex: 1;
  }

  /* Tag puts its content in an inline span, where an icon would sit on the text's baseline. */
  .tag-icon {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    vertical-align: top;
  }

  .glyph {
    display: inline-flex;
    font-size: var(--icon-lg);
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
    min-height: 60px;
    max-height: 50vh;
    font-size: var(--fs-base);
    line-height: 1.5;
    padding: var(--sp-3) var(--sp-4);
  }

  .shown {
    cursor: text;
    overflow-wrap: anywhere;
  }

  .subject.shown {
    line-height: 1.4;
  }

  .body.shown {
    height: auto;
    max-height: none;
  }

  .placeholder {
    color: var(--muted);
    font-weight: normal;
  }

  .shown.readonly {
    cursor: auto;
    user-select: text;
  }

  .field-input:disabled,
  .shown.readonly {
    background: transparent;
    border-color: transparent;
    opacity: 1;
  }

  .people {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--gap-3) var(--sp-4);
    align-items: start;
  }

  .people > label,
  .people > .label {
    padding-top: var(--gap-3);
    font-size: var(--fs-sm);
  }

  .person {
    display: grid;
    grid-template-columns: auto 1fr 1.2fr;
    align-items: center;
    gap: var(--gap-3);
  }

  .actions {
    display: flex;
    gap: var(--gap-3);
  }

  .loading {
    padding: var(--sp-5);
  }

  .split {
    position: sticky;
    bottom: var(--sp-4);
    margin: auto var(--sp-5) var(--sp-4);
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--gap-4) var(--gap-4) var(--gap-4) var(--sp-5);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--theme-mid);
    color: var(--theme2);
    animation: rise var(--dur) var(--ease);
    z-index: var(--z-sticky);
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

  .msg {
    flex: 1;
  }
</style>
