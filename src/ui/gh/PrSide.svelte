<script lang="ts">
  // Beside a pull request's conversation: its reviewers (with their latest review), assignees,
  // labels and size. Reviewers and labels change from a menu of the repository's choices.
  import { Avatar, IconButton, Tag, tooltip } from 'purr';
  import { ChatCircleFill, CheckCircleFill, CircleFill, CircleRegular, GearRegular, MinusCircleFill, XCircleFill, type GlyphComponent } from 'purr/glyphs';
  import type { PrLabel, PrOptions, PrOverview, PrReviewer } from '../../shared/gh-prview.ts';
  import { isLive } from '../../shared/github.ts';
  import { REVIEW_LABEL, ghAvatar } from '../lib/gh-prview.ts';
  import PickMany, { type Choice } from './PickMany.svelte';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
    options: () => Promise<PrOptions | null>;
  }
  let { pr, act, working, options }: Props = $props();

  const open = $derived(isLive(pr.state));

  const REVIEW: Record<PrReviewer['state'], { icon: GlyphComponent; color: string }> = {
    approved: { icon: CheckCircleFill, color: 'var(--success)' },
    changes: { icon: XCircleFill, color: 'var(--danger)' },
    commented: { icon: ChatCircleFill, color: 'var(--muted)' },
    dismissed: { icon: MinusCircleFill, color: 'var(--faint)' },
    pending: { icon: CircleFill, color: 'var(--faint)' },
    requested: { icon: CircleRegular, color: 'var(--warn)' },
  };

  /** The picker open, if any (see PickMany): its choices apply in one go when it closes. */
  let picking = $state<{ anchor: HTMLElement; title: string; choices: Choice[]; chosen: string[]; apply: (keys: string[]) => void } | null>(null);
  /** Labels just applied, shown until the pull request comes back with them. */
  let applying = $state.raw<PrLabel[] | null>(null);
  const labels = $derived(applying ?? pr.labels);
  let picker = $state<PickMany>();

  /** Asked to add `next`'s and remove what's gone from `now`; nothing when they're the same. */
  const diff = (now: string[], next: string[]) => ({ add: next.filter((x) => !now.includes(x)), remove: now.filter((x) => !next.includes(x)) });

  async function pickReviewers(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (picking) return picker?.close();
    const anchor = e.currentTarget;
    const users = (await options())?.users;
    if (!users) return;
    const choice = (login: string, avatar: string | null, group?: string): Choice => {
      const review = pr.reviewers.find((r) => r.login === login && r.state !== 'requested');
      return { key: login, label: login, avatar: ghAvatar(avatar), note: review ? REVIEW_LABEL[review.state] : undefined, group };
    };
    const suggested = pr.suggested.filter((u) => u.login !== pr.author?.login);
    const others = users.filter((u) => u.login !== pr.author?.login && !suggested.some((s) => s.login === u.login));
    const rest = suggested.length ? 'Everyone else' : undefined;
    const requested = pr.reviewers.filter((r) => r.state === 'requested').map((r) => r.login);
    picking = {
      anchor,
      title: 'Request a review from',
      choices: [
        ...suggested.map((u) => choice(u.login, u.avatar, 'Suggested')),
        ...others.map((u) => choice(u.login, u.avatar, rest)),
        ...pr.reviewers.filter((r) => r.team).map((r) => choice(r.login, r.avatar, rest)),
      ],
      chosen: requested,
      apply: (keys) => {
        const change = diff(requested, keys);
        if (change.add.length || change.remove.length) act('prviewReviewers', change);
      },
    };
  }

  async function pickLabels(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (picking) return picker?.close();
    const anchor = e.currentTarget;
    const all = (await options())?.labels;
    if (!all) return;
    const now = pr.labels.map((l) => l.name);
    picking = {
      anchor,
      title: 'Apply labels to this pull request',
      choices: all.map((l) => ({ key: l.name, label: l.name, color: `#${l.color}`, description: l.description ?? undefined })),
      chosen: now,
      apply: async (keys) => {
        const change = diff(now, keys);
        if (!change.add.length && !change.remove.length) return;
        applying = keys.map((k) => all.find((l) => l.name === k) ?? { name: k, color: 'ededed' });
        await act('prviewLabels', change);
        applying = null;
      },
    };
  }
</script>

{#if picking}
  {@const p = picking}
  <PickMany bind:this={picker} anchor={p.anchor} title={p.title} choices={p.choices} chosen={p.chosen} onclose={(keys) => (p.apply(keys), (picking = null))} />
{/if}

<aside class="side">
  <section>
    <header>
      <h3>Reviewers</h3>
      {#if open && pr.canUpdate}
        <IconButton label="Request a review" size="sm" disabled={working} onclick={pickReviewers}><GearRegular /></IconButton>
      {/if}
    </header>
    {#if pr.reviewers.length}
      <ul>
        {#each pr.reviewers as r (r.login)}
          {@const s = REVIEW[r.state]}
          <li>
            <Avatar name={r.login} src={ghAvatar(r.avatar)} size={18} round />
            <span class="name">{r.login}</span>
            <span class="review" style:color={s.color} use:tooltip={REVIEW_LABEL[r.state]} role="img" aria-label={REVIEW_LABEL[r.state]}>
              <s.icon />
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">No reviews yet</p>
    {/if}
  </section>

  <section>
    <header><h3>Assignees</h3></header>
    {#if pr.assignees.length}
      <ul>
        {#each pr.assignees as a (a.login)}
          <li><Avatar name={a.login} src={ghAvatar(a.avatar)} size={18} round /><span class="name">{a.login}</span></li>
        {/each}
      </ul>
    {:else}
      <p class="muted">No one</p>
    {/if}
  </section>

  <section>
    <header>
      <h3>Labels</h3>
      {#if pr.canUpdate}
        <IconButton label="Change labels" size="sm" disabled={working} onclick={pickLabels}><GearRegular /></IconButton>
      {/if}
    </header>
    {#if labels.length}
      <div class="labels">
        {#each labels as l (l.name)}<Tag label={l.name} color="#{l.color}" />{/each}
      </div>
    {:else}
      <p class="muted">None</p>
    {/if}
  </section>

  <section>
    <header><h3>Changes</h3></header>
    <p class="size">
      <span class="add">+{pr.additions}</span>
      <span class="del">−{pr.deletions}</span>
      <span class="muted">in {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</span>
    </p>
  </section>
</aside>

<style>
  .side {
    position: sticky;
    top: var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    min-width: 0;
    font-size: var(--fs-sm);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  section + section {
    padding-top: var(--sp-4);
    border-top: 1px solid var(--border);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--btn-sm);
  }

  h3 {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--muted);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review {
    display: inline-flex;
    font-size: var(--icon-lg);
  }

  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
  }

  p {
    margin: 0;
  }

  .size {
    display: flex;
    gap: var(--gap-4);
    font-family: var(--mono);
  }

  .size .muted {
    font-family: var(--font);
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }

  @container (max-width: 720px) {
    .side {
      position: static;
      flex-direction: row;
      flex-wrap: wrap;
      gap: var(--sp-4) var(--sp-5);
    }

    section + section {
      padding-top: 0;
      border-top: none;
    }

    section {
      min-width: 140px;
    }
  }
</style>
