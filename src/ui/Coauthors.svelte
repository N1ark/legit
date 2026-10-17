<script lang="ts">
  // Editable list of co-authors, one `Name <email>` per line, with suggestions from history.
  import { Button, IconButton } from 'purr';
  import { Plus, X } from 'purr/icons';
  import PersonField from './PersonField.svelte';

  let { value = $bindable(), readonly = false, oninput }: { value: string[]; readonly?: boolean; oninput?: () => void } =
    $props();

  let list = $state<HTMLElement>();

  function add() {
    value.push('');
    oninput?.();
    requestAnimationFrame(() => [...(list?.querySelectorAll('input') ?? [])].at(-1)?.focus());
  }

  function remove(i: number) {
    value.splice(i, 1);
    oninput?.();
  }
</script>

<div class="coauthors" bind:this={list}>
  {#each value as _, i (i)}
    <PersonField bind:value={value[i]} {readonly} {oninput}>
      {#if !readonly}
        <IconButton label="Remove" onclick={() => remove(i)}><X /></IconButton>
      {/if}
    </PersonField>
  {/each}
  {#if !readonly}
    <span class="add"><Button variant="ghost" onclick={add}><Plus /> Add co-author</Button></span>
  {/if}
</div>

<style>
  .coauthors {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    align-items: stretch;
  }

  .add {
    align-self: flex-start;
  }
</style>
