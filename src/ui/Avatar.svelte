<script lang="ts">
  // A person's GitHub avatar, or their initials on a colour derived from their email.
  import { app } from './lib/app.svelte.ts';

  let { email, name, size = 16 }: { email: string; name: string; size?: number } = $props();

  const key = $derived(email.trim().toLowerCase());
  const url = $derived(app.avatars[key]);
  let failed = $state(false);
  const src = $derived(
    !url ? null
    : url.includes('avatars.githubusercontent.com') ? `${url}&s=${size * 2}`
    : `${url}?size=${size * 2}`,
  );
  const initials = $derived(
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => [...w][0] ?? '')
      .join('')
      .toUpperCase() || '?',
  );
  const hue = $derived([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

{#if src && !failed}
  <img
    class="avatar"
    {src}
    alt=""
    width={size}
    height={size}
    loading="lazy"
    decoding="async"
    onerror={() => (failed = true)}
    title="{name} <{email}>"
  />
{:else}
  <span
    class="avatar initials"
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{Math.round(size * 0.45)}px"
    style:background="hsl({hue} 38% 42%)"
    title="{name} <{email}>">{initials}</span
  >
{/if}

<style>
  .avatar {
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
    background: var(--bg3);
  }

  .initials {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    letter-spacing: -0.02em;
    user-select: none;
  }
</style>
