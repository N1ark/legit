<script lang="ts">
  // A new GitHub issue: its title, a markdown description (written or previewed), labels and
  // assignees. Closing it without creating keeps what was typed for next time.
  import { Avatar, Button, Kbd, Modal, Segmented, Spinner, Tag, TextArea, TextField, errorMessage, matches, tooltip } from 'purr';
  import { TagRegular, UserPlusRegular } from 'purr/glyphs';
  import { untrack } from 'svelte';
  import Markdown from '../Markdown.svelte';
  import { type IssueDraft, createIssue, issueMeta } from '../lib/gh-issues.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';
  import PickMany, { type Choice } from './PickMany.svelte';
  import { refComplete } from './ref-complete.svelte.ts';
  import type { IssueMeta } from '../../shared/gh-issues.ts';

  interface Props {
    draft: IssueDraft;
    /** With what was typed, when closed without creating. */
    onclose: (left?: IssueDraft) => void;
  }
  let { draft, onclose }: Props = $props();

  const init = untrack(() => draft);
  let title = $state(init.title);
  let body = $state(init.body);
  let labels = $state<string[]>(init.labels);
  let assignees = $state<string[]>(init.assignees);
  let mode = $state<'write' | 'preview'>('write');
  let busy = $state(false);

  let meta = $state.raw<IssueMeta | null>(null);
  let metaError = $state<string | null>(null);
  issueMeta().then(
    (m) => (meta = m),
    (e) => (metaError = errorMessage(e)),
  );

  const left = () => ({ title, body, labels, assignees });
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const labelOf = (name: string) => meta?.labels.find((l) => l.name === name);
  const avatarOf = (login: string) => meta?.assignees.find((u) => u.login === login)?.avatar ?? `https://github.com/${login}.png`;

  /** The picker open, if any (see PickMany). */
  let picking = $state<{ anchor: HTMLElement; title: string; choices: Choice[]; chosen: string[]; apply: (keys: string[]) => void } | null>(null);
  let picker = $state<PickMany>();

  function pickLabels(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (picking) return picker?.close();
    picking = {
      anchor: e.currentTarget,
      title: 'Apply labels to this issue',
      choices: (meta?.labels ?? []).map((l) => ({ key: l.name, label: l.name, color: `#${l.color}`, description: l.description ?? undefined })),
      chosen: labels,
      apply: (keys) => (labels = keys),
    };
  }

  function pickAssignees(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (picking) return picker?.close();
    picking = {
      anchor: e.currentTarget,
      title: 'Assign people to this issue',
      choices: (meta?.assignees ?? []).map((u) => ({ key: u.login, label: u.login, avatar: u.avatar })),
      chosen: assignees,
      apply: (keys) => (assignees = keys),
    };
  }

  async function create() {
    if (!title.trim() || busy) return;
    busy = true;
    const ok = await createIssue({ title: title.trim(), body, labels, assignees });
    busy = false;
    if (ok) onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing) {
      e.preventDefault();
      create();
    }
  }
</script>

<Modal
  label="New issue"
  title="New issue in {meta?.repo ?? gh.status?.repo ?? 'GitHub'}"
  onclose={() => onclose(left())}
  width="min(680px, calc(100vw - 32px))"
  align="top"
  padded
  {onkeydown}
>
  <div class="form">
    <TextField bind:value={title} placeholder="Title" aria-label="Title" data-autofocus />
    <div class="tabs">
      <Segmented
        label="Description"
        size="sm"
        bind:value={mode}
        options={[
          { id: 'write', label: 'Write' },
          { id: 'preview', label: 'Preview' },
        ]}
      />
      <span class="muted hint">Markdown · # to mention</span>
    </div>
    {#if mode === 'write'}
      <TextArea bind:value={body} rows={10} placeholder="Description" aria-label="Description" {@attach refComplete} />
    {:else}
      <div class="preview">
        {#if body.trim()}<Markdown text={body} />{:else}<span class="muted">Nothing to preview.</span>{/if}
      </div>
    {/if}
    <div class="pick">
      <Button size="sm" disabled={!meta} onclick={pickLabels}><TagRegular /> Labels</Button>
      {#each labels as name (name)}
        <span use:tooltip={labelOf(name)?.description}>
          <Tag onremove={() => (labels = toggle(labels, name))} removeLabel="Remove {name}">
            {@const color = labelOf(name)?.color}
            <span class="dot" style:background={color ? `#${color}` : 'var(--faint)'}></span>{name}
          </Tag>
        </span>
      {/each}
    </div>
    <div class="pick">
      <Button size="sm" disabled={!meta} onclick={pickAssignees}><UserPlusRegular /> Assignees</Button>
      {#each assignees as login (login)}
        <Tag onremove={() => (assignees = toggle(assignees, login))} removeLabel="Unassign {login}">
          <Avatar name={login} src={avatarOf(login)} size={14} round title="" />{login}
        </Tag>
      {/each}
    </div>
    {#if metaError}
      <p class="muted">Couldn't load the labels and assignees: {metaError}</p>
    {:else if !meta}
      <p class="muted"><Spinner size={12} /> Loading…</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button onclick={() => onclose(left())}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!title.trim()} onclick={create}>Create <Kbd hint="⌘↩" /></Button>
  {/snippet}
  {#if picking}
    {@const p = picking}
    <PickMany bind:this={picker} anchor={p.anchor} title={p.title} choices={p.choices} chosen={p.chosen} onclose={(keys) => (p.apply(keys), (picking = null))} />
  {/if}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    margin-bottom: calc(-1 * var(--gap-3));
  }

  .hint {
    font-size: var(--fs-xs);
  }

  .preview {
    min-height: 180px;
    max-height: 40vh;
    overflow: auto;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
  }

  .pick {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-3);
  }

  .pick :global(.tag) {
    gap: var(--gap-2);
  }

  /* A GitHub label's own colour, as a dot. */
  .dot {
    display: inline-block;
    width: 0.7em;
    height: 0.7em;
    margin-right: var(--gap-2);
    border-radius: var(--radius-pill);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    vertical-align: -0.05em;
  }

  .pick :global(.avatar) {
    margin-right: var(--gap-2);
  }

  p {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    margin: 0;
    font-size: var(--fs-sm);
  }
</style>
