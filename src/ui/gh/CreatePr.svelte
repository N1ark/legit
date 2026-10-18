<script lang="ts">
  // "Create pull request" for the current branch: its title and description start from its
  // commits since the base (one commit: its message; several: the branch's name and their
  // subjects), the base is the default branch or, when this branch was started from one with an
  // open pull request, that one (stacking on it). The branch is pushed first when GitHub doesn't
  // have all of it.
  import { Button, Checkbox, Field, Kbd, Modal, Spinner, TextArea, TextField, matches, toast } from 'purr';
  import { GitPullRequest } from 'purr/icons';
  import { tick } from 'svelte';
  import { app } from '../lib/app.svelte.ts';
  import { ghRequest } from '../lib/github.svelte.ts';
  import { prDraft } from '../lib/gh-pr.ts';
  import { createPr } from '../lib/gh-prs.svelte.ts';
  import type { PrCreateInfo } from '../../shared/gh-stack.ts';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  const branch = app.repo?.branch ?? '';
  let info = $state.raw<PrCreateInfo | null>(null);
  let base = $state('');
  let title = $state('');
  let body = $state('');
  let draft = $state(false);
  let sending = $state(false);
  let titleInput = $state<HTMLInputElement | null>(null);
  /** Title or description typed in: a new base no longer replaces them. */
  let edited = false;

  async function load(wanted?: string) {
    try {
      const i = await ghRequest<PrCreateInfo>('prCreateInfo', { branch, base: wanted });
      if (wanted !== undefined && wanted !== base) return;
      info = i;
      base = i.base;
      if (!edited) ({ title, body } = prDraft(branch, i.commits));
      if (wanted === undefined) await tick().then(() => titleInput?.select());
    } catch (e) {
      toast.error(e);
      if (!info) onclose();
    }
  }
  load();

  const push = $derived(app.repo?.push ?? null);
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const pushNote = $derived(
    !push ? ''
    : push.publish ? `Publishes ${branch} to ${push.remote} first`
    : push.ahead && !push.behind ? `Pushes ${commits(push.ahead)} to ${push.remote}/${push.branch} first`
    : '',
  );
  /** Nothing on this branch that the base doesn't have: GitHub would refuse it. */
  const empty = $derived(info?.base === base && !info.commits.length);
  const optionLabel = (b: string) =>
    b === info?.trunk ? `${b} (default)` : b === info?.suggested?.base ? `${b} (stack on #${info.suggested.number})` : b;

  async function submit() {
    if (!title.trim() || !base || sending || empty) return;
    sending = true;
    const pr = await createPr({ title: title.trim(), body, base, draft }).finally(() => (sending = false));
    if (pr) onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (!matches('⌘↩', e) || e.isComposing) return;
    e.preventDefault();
    submit();
  }
</script>

<Modal label="Create pull request" title="Create pull request" {onclose} {onkeydown} width="min(640px, calc(100vw - 32px))" padded>
  {#if !info}
    <div class="loading"><Spinner label="Loading" /></div>
  {:else}
    <div class="form">
      <Field label="Merge {branch} into">
        <select class="field-input mono" bind:value={base} onchange={() => load(base)} disabled={sending}>
          {#each info.bases as b (b)}<option value={b}>{optionLabel(b)}</option>{/each}
        </select>
      </Field>
      <p class="muted note">
        {info.base !== base ? 'Loading…'
        : empty ? `Nothing ${base} doesn't have yet.`
        : `${commits(info.commits.length)} ${base} doesn't have.`}
        {#if info.suggested && base !== info.suggested.base}
          Started from <span class="mono">{info.suggested.base}</span> (#{info.suggested.number}): stack on it to show only this
          branch's changes.
        {/if}
      </p>
      <TextField label="Title" bind:value={title} bind:input={titleInput} oninput={() => (edited = true)} disabled={sending} />
      <TextArea label="Description" bind:value={body} oninput={() => (edited = true)} rows={8} disabled={sending} placeholder="Markdown" />
      <Checkbox label="Draft" bind:checked={draft} disabled={sending} />
    </div>
  {/if}
  {#snippet footer()}
    <span class="muted note">{pushNote}</span>
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" onclick={submit} disabled={!info || !title.trim() || sending || empty}>
      {#if sending}<Spinner label="Creating" />{:else}<GitPullRequest />{/if}
      {draft ? 'Create draft PR' : 'Create PR'}
      <Kbd hint="⌘↩" />
    </Button>
  {/snippet}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: var(--sp-5);
  }

  .note {
    margin: calc(-1 * var(--gap-3)) 0 0;
    font-size: var(--fs-xs);
  }

  .note:first-child {
    flex: 1;
    margin: 0;
  }
</style>
