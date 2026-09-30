<script lang="ts">
  // Editable list of co-authors, one `Name <email>` per line, with suggestions from history.
  import { Avatar, Button, IconButton } from 'purr';
  import { Plus, X } from 'purr/icons';
  import { app, avatarUrl } from './lib/app.svelte.ts';
  import { formatPerson, parsePerson } from './lib/people.ts';

  let { value = $bindable(), readonly = false, oninput }: { value: string[]; readonly?: boolean; oninput?: () => void } =
    $props();

  let list = $state<HTMLElement>();

  function add() {
    value.push('');
    oninput?.();
    requestAnimationFrame(() => list?.querySelector<HTMLInputElement>('.coauthor:last-of-type input')?.focus());
  }

  function remove(i: number) {
    value.splice(i, 1);
    oninput?.();
  }
</script>

<div class="coauthors" bind:this={list}>
  {#each value as _, i (i)}
    {@const who = parsePerson(value[i])}
    {@const email = who?.email ?? ''}
    <div class="coauthor">
      <Avatar name={who?.name || '?'} src={avatarUrl(email, 22)} seed={email.toLowerCase()} size={22} round />
      <input
        class="field-input"
        bind:value={value[i]}
        {oninput}
        list="people"
        placeholder="Name <email@example.com>"
        aria-invalid={!!value[i].trim() && !parsePerson(value[i])}
        disabled={readonly}
      />
      {#if !readonly}
        <IconButton label="Remove" onclick={() => remove(i)}><X /></IconButton>
      {/if}
    </div>
  {/each}
  {#if !readonly}
    <span class="add"><Button variant="ghost" onclick={add}><Plus /> Add co-author</Button></span>
  {/if}
</div>

<datalist id="people">
  {#each app.people as p (p.email)}<option value={formatPerson(p)}></option>{/each}
</datalist>

<style>
  .coauthors {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    align-items: stretch;
  }

  .coauthor {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .field-input:disabled {
    background: transparent;
    border-color: transparent;
    opacity: 1;
  }

  .add {
    align-self: flex-start;
  }
</style>
