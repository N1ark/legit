<script lang="ts">
  // Editable list of co-authors, one `Name <email>` per line, with suggestions from history.
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { app } from './lib/app.svelte.ts';
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
    <div class="coauthor">
      <input
        bind:value={value[i]}
        {oninput}
        list="people"
        placeholder="Name <email@example.com>"
        class:invalid={value[i].trim() && !parsePerson(value[i])}
        disabled={readonly}
      />
      {#if !readonly}
        <button class="ghost" onclick={() => remove(i)} title="Remove"><XIcon size={13} /></button>
      {/if}
    </div>
  {/each}
  {#if !readonly}
    <button class="ghost add" onclick={add}><PlusIcon size={13} /> Add co-author</button>
  {/if}
</div>

<datalist id="people">
  {#each app.people as p (p.email)}<option value={formatPerson(p)}></option>{/each}
</datalist>

<style>
  .coauthors {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
  }

  .coauthor {
    display: flex;
    gap: 4px;
  }

  .coauthor input {
    flex: 1;
  }

  input:disabled {
    background: transparent;
    border-color: transparent;
    color: inherit;
    opacity: 1;
  }

  .invalid {
    border-color: var(--del);
  }

  .add {
    align-self: flex-start;
    color: var(--dim);
    font-size: 12px;
    padding: 4px 6px;
  }
</style>
