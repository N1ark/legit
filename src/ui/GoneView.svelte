<script lang="ts">
  // In place of everything, once the worktree shown is gone (deleted or moved outside legit): what
  // happened, and the worktree the window goes to instead; if there's none, the way to another repository.
  import { IS_TAURI, Spinner, toast } from 'purr';
  import { FolderOpenRegular } from 'purr/glyphs';
  import type { RepoGone } from '../shared/types.ts';
  import { invoke } from './lib/desktop.ts';

  interface Props {
    gone: RepoGone;
  }

  let { gone }: Props = $props();

  interface RecentRepo {
    path: string;
    name: string;
    short: string;
    current: boolean;
  }

  let recent = $state.raw<RecentRepo[]>([]);
  $effect(() => {
    if (IS_TAURI && !gone.to) invoke<RecentRepo[]>('recent_repos').then((r) => (recent = r.filter((x) => x.path !== gone.root).slice(0, 6)), () => {});
  });

  const name = $derived(gone.root.split(/[\\/]/).filter(Boolean).at(-1) ?? gone.root);
  const to = $derived(gone.to?.split(/[\\/]/).filter(Boolean).at(-1));

  async function go(cmd: string, args?: Record<string, unknown>) {
    try {
      await invoke(cmd, args);
    } catch (e) {
      toast.error(e);
    }
  }
</script>

<div class="gone" data-tauri-drag-region>
  <div class="card">
    <h1>{name} is gone</h1>
    <p class="muted">{gone.root} was deleted or moved outside legit.</p>
    {#if gone.to}
      <p class="going"><Spinner label="Opening" /> Opening {to}…</p>
    {:else if IS_TAURI}
      <div class="actions">
        <button class="btn btn--primary" onclick={() => go('pick_repo')}><FolderOpenRegular /> Open a repository…</button>
      </div>
      {#if recent.length}
        <ul>
          {#each recent as r (r.path)}
            <li><button class="btn btn--ghost" onclick={() => go('open_repo', { path: r.path })}>{r.name} <span class="muted">{r.short}</span></button></li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p>Run <code>legit</code> in another repository to carry on.</p>
    {/if}
  </div>
</div>

<style>
  .gone {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-5);
    background: var(--bg2);
  }

  .card {
    max-width: 520px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    text-align: center;
    overflow-wrap: anywhere;
  }

  h1 {
    font-size: var(--fs-xl);
    color: var(--color2);
  }

  .going,
  .actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--gap-3);
  }

  ul {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-1);
  }

  li button {
    gap: var(--gap-3);
  }
</style>
