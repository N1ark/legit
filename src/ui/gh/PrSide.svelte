<script lang="ts">
  // Beside a pull request's conversation: its reviewers (with their latest review), assignees,
  // labels and size. Reviewers and labels change from a menu of the repository's choices.
  import { Avatar, IconButton, Tag, entries, menu, type MaybeEntry } from 'purr';
  import { ChatCircle, CheckCircle, Circle, Gear, MinusCircle, XCircle } from 'purr/icons';
  import type { PrOptions, PrOverview, PrReviewer } from '../../shared/gh-prview.ts';
  import { REVIEW_LABEL, ghAvatar } from '../lib/gh-prview.ts';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
    options: () => Promise<PrOptions | null>;
  }
  let { pr, act, working, options }: Props = $props();

  const open = $derived(pr.state === 'open' || pr.state === 'draft');

  const REVIEW: Record<PrReviewer['state'], { icon: typeof Circle; color: string }> = {
    approved: { icon: CheckCircle, color: 'var(--success)' },
    changes: { icon: XCircle, color: 'var(--danger)' },
    commented: { icon: ChatCircle, color: 'var(--muted)' },
    dismissed: { icon: MinusCircle, color: 'var(--faint)' },
    pending: { icon: Circle, color: 'var(--faint)' },
    requested: { icon: Circle, color: 'var(--warn)' },
  };

  async function pickReviewers(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    const anchor = e.currentTarget;
    const users = (await options())?.users;
    if (!users) return;
    const item = (login: string, avatar: string | null): MaybeEntry => {
      const requested = pr.reviewers.some((r) => r.login === login && r.state === 'requested');
      const review = pr.reviewers.find((r) => r.login === login && r.state !== 'requested');
      return {
        label: login,
        icon: Avatar,
        iconProps: { name: login, src: ghAvatar(avatar), size: 16, round: true, title: '' },
        checked: requested,
        keepOpen: true,
        note: review ? REVIEW_LABEL[review.state] : undefined,
        run: () => act('prviewReviewers', requested ? { remove: [login] } : { add: [login] }),
      };
    };
    const suggested = pr.suggested.filter((u) => u.login !== pr.author?.login);
    const others = users.filter((u) => u.login !== pr.author?.login && !suggested.some((s) => s.login === u.login));
    menu.showFor(
      anchor,
      () =>
        entries(
          suggested.length > 0 && { kind: 'heading', label: 'Suggested' },
          ...suggested.map((u) => item(u.login, u.avatar)),
          suggested.length > 0 && 'separator',
          ...others.map((u) => item(u.login, u.avatar)),
          ...pr.reviewers.filter((r) => r.team).map((r) => item(r.login, r.avatar)),
        ),
      'Request a review from',
    );
  }

  async function pickLabels(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    const anchor = e.currentTarget;
    const labels = (await options())?.labels;
    if (!labels) return;
    menu.showFor(
      anchor,
      () =>
        labels.map((l) => {
          const on = pr.labels.some((x) => x.name === l.name);
          return {
            label: l.name,
            swatch: `#${l.color}`,
            checked: on,
            keepOpen: true,
            run: () => act('prviewLabels', on ? { remove: [l.name] } : { add: [l.name] }),
          };
        }),
      'Labels',
    );
  }
</script>

<aside class="side">
  <section>
    <header>
      <h3>Reviewers</h3>
      {#if open && pr.canUpdate}
        <IconButton label="Request a review" size="sm" disabled={working} onclick={pickReviewers}><Gear /></IconButton>
      {/if}
    </header>
    {#if pr.reviewers.length}
      <ul>
        {#each pr.reviewers as r (r.login)}
          {@const s = REVIEW[r.state]}
          <li>
            <Avatar name={r.login} src={ghAvatar(r.avatar)} size={18} round />
            <span class="name">{r.login}</span>
            <span class="review" style:color={s.color} title={REVIEW_LABEL[r.state]} aria-label={REVIEW_LABEL[r.state]}>
              <s.icon weight={r.state === 'requested' ? 'regular' : 'fill'} />
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
        <IconButton label="Change labels" size="sm" disabled={working} onclick={pickLabels}><Gear /></IconButton>
      {/if}
    </header>
    {#if pr.labels.length}
      <div class="labels">
        {#each pr.labels as l (l.name)}<Tag label={l.name} color="#{l.color}" />{/each}
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
