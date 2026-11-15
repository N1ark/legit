<script lang="ts">
  // Beside a pull request's conversation: its reviewers (with their latest review), assignees,
  // labels, milestone, the issues it closes and size. Reviewers, assignees, labels and milestone
  // change from a menu of the repository's choices.
  import { Avatar, IconButton, Tag, formatDate, menu, tooltip } from 'purr';
  import { ChatCircleFill, CheckCircleFill, CircleFill, CircleRegular, GearRegular, InfoRegular, MinusCircleFill, XCircleFill, type GlyphComponent } from 'purr/glyphs';
  import type { PrLabel, PrOptions, PrOverview, PrReviewer } from '../../shared/gh-prview.ts';
  import { type GhUser, isLive } from '../../shared/github.ts';
  import { app } from '../lib/app.svelte.ts';
  import { REVIEW_LABEL, ghAvatar } from '../lib/gh-prview.ts';
  import { ghRequest } from '../lib/github.svelte.ts';
  import PickMany, { type Choice } from './PickMany.svelte';
  import RefIcon from './RefIcon.svelte';
  import { refStateWords } from '../lib/gh-links.ts';
  import { addClosing, removeClosing } from '../lib/closing.ts';
  import type { IssueRef } from '../../shared/gh-issues.ts';
  import ReviewerActions from './ReviewerActions.svelte';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
    options: () => Promise<PrOptions | null>;
  }
  let { pr, act, working, options }: Props = $props();

  const open = $derived(isLive(pr.state));
  /** `owner/name`, to name another repository's issues in full. */
  const here = $derived(pr.url.split('/').slice(3, 5).join('/').toLowerCase());
  const CLOSES_TIP = 'Issues named by “Closes #N” in the description: linking one adds that line, unlinking takes it out';

  const REVIEW: Record<PrReviewer['state'], { icon: GlyphComponent; color: string }> = {
    approved: { icon: CheckCircleFill, color: 'var(--success)' },
    changes: { icon: XCircleFill, color: 'var(--danger)' },
    commented: { icon: ChatCircleFill, color: 'var(--muted)' },
    dismissed: { icon: MinusCircleFill, color: 'var(--faint)' },
    pending: { icon: CircleFill, color: 'var(--faint)' },
    requested: { icon: CircleRegular, color: 'var(--warn)' },
  };

  /** The picker open, if any (see PickMany): its choices apply in one go when it closes. */
  let picking = $state<{ anchor: HTMLElement; title: string; choices: Choice[]; chosen: string[]; apply: (keys: string[]) => void; search?: (q: string) => Promise<Choice[]> } | null>(null);

  /** People who can be assigned (or asked for a review) whose login or name matches `q`, past the first 100 listed. */
  const people = (q: string, but: string[] = []) =>
    ghRequest<GhUser[]>('prviewUsers', { number: pr.number, q }).then((users) =>
      users.filter((u) => !but.includes(u.login)).map((u): Choice => ({ key: u.login, label: u.login, avatar: ghAvatar(u.avatar) })),
    );
  /** Labels just applied, shown until the pull request comes back with them. */
  let applying = $state.raw<PrLabel[] | null>(null);
  const labels = $derived(applying ?? pr.labels);
  /** Likewise for assignees. */
  let assigning = $state.raw<GhUser[] | null>(null);
  const assignees = $derived(assigning ?? pr.assignees);
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
      search: (q) => people(q, pr.author ? [pr.author.login] : []),
    };
  }

  async function setAssignees(now: string[], keys: string[], users: GhUser[]) {
    const change = diff(now, keys);
    if (!change.add.length && !change.remove.length) return;
    assigning = keys.map((k) => users.find((u) => u.login === k) ?? { login: k, avatar: '' });
    await act('prviewAssignees', change);
    assigning = null;
  }

  async function pickAssignees(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (picking) return picker?.close();
    const anchor = e.currentTarget;
    const users = (await options())?.users;
    if (!users) return;
    const now = pr.assignees.map((a) => a.login);
    const found: GhUser[] = [];
    // The current ones first, as GitHub has them, even when they're no longer assignable.
    const all = [...pr.assignees, ...users.filter((u) => !now.includes(u.login))];
    picking = {
      anchor,
      title: 'Assign up to 10 people to this pull request',
      choices: all.map((u) => ({ key: u.login, label: u.login, avatar: ghAvatar(u.avatar) })),
      chosen: now,
      apply: (keys) => setAssignees(now, keys.slice(0, 10), [...all, ...found]),
      search: async (q) => {
        const more = await people(q);
        found.push(...more.map((c) => ({ login: c.key, avatar: c.avatar ?? '' })));
        return more;
      },
    };
  }

  /** Issues to link: recent open ones, or those matching what's typed (pull requests left out). */
  const issues = (q: string) =>
    ghRequest<IssueRef[]>('issuesSearch', { q }).then((list) =>
      list.filter((i) => !i.isPullRequest).map((i): Choice => ({ key: `${i.repo}#${i.number}`, label: `#${i.number} ${i.title}`, description: refStateWords(i) })),
    );

  async function pickIssues(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (picking) return picker?.close();
    const anchor = e.currentTarget;
    const now = pr.closes.map((i) => `${i.repo}#${i.number}`);
    const linked = pr.closes.map((i): Choice => ({ key: `${i.repo}#${i.number}`, label: `${i.repo.toLowerCase() === here ? '' : i.repo}#${i.number} ${i.title}` }));
    const recent = await issues('').catch(() => [] as Choice[]);
    picking = {
      anchor,
      title: 'Link issues this pull request closes',
      choices: [...linked, ...recent.filter((c) => !now.includes(c.key))],
      chosen: now,
      apply: (keys) => {
        const ref = (k: string) => {
          const [repo, n] = k.split('#');
          return [repo, Number(n)] as const;
        };
        let body = pr.body;
        for (const k of now.filter((k) => !keys.includes(k))) body = removeClosing(body, ...ref(k), here);
        for (const k of keys.filter((k) => !now.includes(k))) body = addClosing(body, ...ref(k), here);
        if (body !== pr.body) act('prviewEdit', { body }, 'Linked issues updated in the description');
      },
      search: issues,
    };
  }

  async function pickMilestone(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    const anchor = e.currentTarget;
    const all = (await options())?.milestones;
    if (!all) return;
    const now = pr.milestone?.number ?? null;
    const set = (milestone: number | null) => void (milestone !== now && act('prviewMilestone', { milestone }));
    menu.showFor(
      anchor,
      [
        ...all.map((m) => ({ label: m.title, note: m.dueOn ? `Due by ${formatDate(m.dueOn)}` : undefined, checked: m.number === now, run: () => set(m.number) })),
        ...(all.length ? ['separator' as const] : []),
        { label: all.length ? 'No milestone' : 'No open milestones', disabled: now === null, checked: !all.length ? undefined : now === null, run: () => set(null) },
      ],
      'Set milestone',
    );
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
  <PickMany bind:this={picker} anchor={p.anchor} title={p.title} choices={p.choices} chosen={p.chosen} search={p.search} onclose={(keys) => (p.apply(keys), (picking = null))} />
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
            {#if open}<ReviewerActions {pr} reviewer={r} {act} {working} />{/if}
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
    <header>
      <h3>Assignees</h3>
      {#if pr.canUpdate}
        <IconButton label="Change assignees" size="sm" disabled={working} onclick={pickAssignees}><GearRegular /></IconButton>
      {/if}
    </header>
    {#if assignees.length}
      <ul>
        {#each assignees as a (a.login)}
          <li><Avatar name={a.login} src={ghAvatar(a.avatar)} size={18} round /><span class="name">{a.login}</span></li>
        {/each}
      </ul>
    {:else}
      <p class="muted">
        No one{#if pr.canUpdate}—<button class="btn btn--link" disabled={working} onclick={() => setAssignees([], [pr.viewer], [])}>assign yourself</button>{/if}
      </p>
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
    <header>
      <h3>Milestone</h3>
      {#if pr.canUpdate}
        <IconButton label="Set milestone" size="sm" disabled={working} onclick={pickMilestone}><GearRegular /></IconButton>
      {/if}
    </header>
    {#if pr.milestone}
      {@const m = pr.milestone}
      <div class="milestone">
        {#if m.url}
          <button class="btn btn--link title" onclick={() => m.url && app.openUrl(m.url)} use:tooltip={'Open on GitHub'}>{m.title}</button>
        {:else}
          <span class="title">{m.title}</span>
        {/if}
        {#if m.progress !== null}
          <span class="bar" role="progressbar" aria-label="{Math.round(m.progress)}% complete" aria-valuenow={Math.round(m.progress)} aria-valuemin={0} aria-valuemax={100}>
            <span style:width="{m.progress}%"></span>
          </span>
        {/if}
        {#if m.dueOn}<span class="muted due">Due by {formatDate(m.dueOn)}</span>{/if}
      </div>
    {:else}
      <p class="muted">None</p>
    {/if}
  </section>

  <section>
    <header>
      <h3>Closes</h3>
      <button class="info muted" aria-label={CLOSES_TIP} use:tooltip={CLOSES_TIP}><InfoRegular /></button>
      {#if pr.canUpdate}
        <IconButton label="Link issues" size="sm" disabled={working} onclick={pickIssues}><GearRegular /></IconButton>
      {/if}
    </header>
    {#if pr.closes.length}
      <ul>
        {#each pr.closes as i (i.url)}
          <li>
            <button class="issue" onclick={() => app.openUrl(i.url)} use:tooltip={`${refStateWords(i)} · open on GitHub`}>
              <RefIcon ref={i} />
              <span class="name"><span class="muted">{i.repo.toLowerCase() === here ? '' : i.repo}#{i.number}</span> {i.title}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">No issues</p>
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

  /* A reviewer's actions show as the pointer or the focus comes to their row. */
  @media (hover: hover) {
    li :global(.reviewer-action:not([aria-expanded='true'])) {
      opacity: 0;
    }

    li:hover :global(.reviewer-action),
    li:focus-within :global(.reviewer-action) {
      opacity: 1;
    }
  }

  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
  }

  p {
    margin: 0;
  }

  .milestone {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    min-width: 0;
  }

  .milestone .title {
    align-self: flex-start;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .bar {
    display: block;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--bg3);
    overflow: hidden;
  }

  .bar > span {
    display: block;
    height: 100%;
    background: var(--success);
  }

  .due {
    font-size: var(--fs-xs);
  }

  .info {
    display: inline-flex;
    font-size: var(--icon-sm);
    border-radius: var(--radius-sm);
  }

  .issue {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    width: 100%;
    min-width: 0;
    text-align: left;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  @media (hover: hover) {
    .issue:hover .name {
      text-decoration: underline;
    }
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
