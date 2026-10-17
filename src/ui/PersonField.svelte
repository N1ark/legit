<script lang="ts">
  // One `Name <email>` field with its avatar, suggesting people from history (App's `people` list).
  import { Avatar } from 'purr';
  import type { Snippet } from 'svelte';
  import { avatarUrl } from './lib/app.svelte.ts';
  import { parseAuthor, parsePerson } from './lib/people.ts';

  interface Props {
    value: string;
    id?: string;
    readonly?: boolean;
    /** It can't be left empty: the author, rather than a co-author. */
    required?: boolean;
    oninput?: () => void;
    /** After the field, as a co-author's remove button. */
    children?: Snippet;
  }

  let { value = $bindable(), id, readonly = false, required = false, oninput, children }: Props = $props();

  const who = $derived(parsePerson(value));
  const email = $derived(who?.email ?? '');
  const invalid = $derived(required ? !parseAuthor(value) : !!value.trim() && !who);
</script>

<div class="person">
  <Avatar name={who?.name || '?'} src={avatarUrl(email, 22)} seed={email.toLowerCase()} size={22} round />
  <input
    class="field-input"
    {id}
    bind:value
    {oninput}
    list="people"
    placeholder="Name <email@example.com>"
    aria-invalid={invalid}
    disabled={readonly}
  />
  {@render children?.()}
</div>

<style>
  .person {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .field-input:disabled {
    background: transparent;
    border-color: transparent;
    opacity: 1;
  }
</style>
