// The signed-in user's GitHub notifications (REST only: GraphQL has none). Polled with
// If-Modified-Since, so a poll that finds nothing new costs no rate limit.

import { GithubError, rest, restSince, takeWarm, warm } from './client.ts';
import { resolveRefs } from './issues.ts';
import { log } from '../log.ts';
import type { GhNotification, GhNotificationType, GhNotifications } from '../../shared/gh-notifications.ts';
import type { GetRoute, PostRoute } from './routes.ts';

const REASONS: Record<string, string> = {
  approval_requested: 'Approval requested',
  assign: 'Assigned',
  author: 'You opened it',
  comment: 'Comment',
  ci_activity: 'CI activity',
  invitation: 'Invitation',
  manual: 'Subscribed',
  member_feature_requested: 'Feature requested',
  mention: 'Mentioned',
  review_requested: 'Review requested',
  security_alert: 'Security alert',
  security_advisory_credit: 'Security advisory',
  state_change: 'State changed',
  subscribed: 'Watching',
  team_mention: 'Team mentioned',
};

const TYPES = new Set(['PullRequest', 'Issue', 'CheckSuite', 'Release', 'Discussion', 'Commit']);

/** github.com's page for a notification's subject, at its latest comment when it has one. */
export function notificationUrl(repo: string, subjectUrl: string | null, commentUrl: string | null, type: string): string {
  const site = `https://github.com/${repo}`;
  const api = `https://api.github.com/repos/${repo}/`;
  const path = subjectUrl?.startsWith(api) ? subjectUrl.slice(api.length) : '';
  let page =
    /^pulls\/(\d+)$/.exec(path) ? `${site}/pull/${path.slice(6)}`
    : /^issues\/\d+$/.test(path) ? `${site}/${path}`
    : /^commits\/[0-9a-f]+$/.test(path) ? `${site}/commit/${path.slice(8)}`
    : type === 'Release' ? `${site}/releases`
    : type === 'CheckSuite' ? `${site}/actions`
    : type === 'Discussion' ? `${site}/discussions`
    : site;
  const comment = commentUrl?.startsWith(api) ? commentUrl.slice(api.length) : '';
  const issueComment = /^issues\/comments\/(\d+)$/.exec(comment);
  const reviewComment = /^pulls\/comments\/(\d+)$/.exec(comment);
  if (issueComment) page += `#issuecomment-${issueComment[1]}`;
  else if (reviewComment) page += `#discussion_r${reviewComment[1]}`;
  return page;
}

export function toNotification(n: any): GhNotification {
  const repo: string = n.repository.full_name;
  const type = (TYPES.has(n.subject.type) ? n.subject.type : 'Other') as GhNotificationType;
  const number = /\/(?:pulls|issues)\/(\d+)$/.exec(n.subject.url ?? '');
  return {
    id: String(n.id),
    unread: !!n.unread,
    reason: REASONS[n.reason] ?? n.reason.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase()),
    updatedAt: Date.parse(n.updated_at),
    repo,
    title: n.subject.title,
    type,
    number: number ? Number(number[1]) : null,
    state: null,
    notPlanned: false,
    url: notificationUrl(repo, n.subject.url, n.subject.latest_comment_url, n.subject.type),
  };
}

const refOf = (n: GhNotification) => `${n.repo}#${n.number}`.toLowerCase();

/** Each pull request's and issue's state (open, merged…), looked up in one query, and again once its thread moves. */
async function withStates(items: GhNotification[]): Promise<GhNotification[]> {
  const subjects = items.filter((n) => n.number !== null && (n.type === 'PullRequest' || n.type === 'Issue'));
  if (!subjects.length) return items;
  try {
    const refs = await resolveRefs(subjects.map(refOf), Object.fromEntries(subjects.map((n) => [refOf(n), n.updatedAt])));
    return items.map((n) => {
      const ref = n.number === null ? null : refs[refOf(n)];
      return ref ? { ...n, state: ref.state, notPlanned: ref.notPlanned } : n;
    });
  } catch (e) {
    log('Notifications: no states,', e instanceof Error ? e.message : e);
    return items;
  }
}

/** The last page fetched, kept for 304s, and patched by our own writes (GitHub's Last-Modified may not move for them). */
let last: { modified: string | null; result: GhNotifications } | null = null;

async function list(fresh: boolean): Promise<GhNotifications> {
  try {
    const res = await restSince<any[]>('/notifications?all=true&per_page=50', fresh ? null : (last?.modified ?? null));
    if (res) last = { modified: res.modified, result: { items: res.data.map(toNotification), poll: res.poll } };
  } catch (e) {
    // Fine-grained tokens can't read notifications at all.
    if (e instanceof GithubError && (e.status === 403 || e.status === 404)) {
      throw new GithubError("This GitHub token can't read notifications: it needs the `notifications` or `repo` scope (`gh auth refresh -s notifications`).", e.status, e.code);
    }
    throw e;
  }
  return { ...last!.result, items: await withStates(last!.result.items) };
}

function patch(ids: (id: string) => boolean, change: 'read' | 'done') {
  if (!last) return;
  const items = last.result.items;
  last.result.items = change === 'done' ? items.filter((n) => !ids(n.id)) : items.map((n) => (ids(n.id) ? { ...n, unread: false } : n));
}

const threadId = (b: any): string => {
  if (typeof b?.id !== 'string' || !/^\d+$/.test(b.id)) throw new GithubError('Which notification?');
  return b.id;
};

/** Fetch them ahead of the page's first look. */
export const warmNotifications = () => warm('notifs', () => list(false));

export const notificationsGet: Record<string, GetRoute> = {
  notifs: (_, q) => (q.get('fresh') === '1' ? list(true) : (takeWarm<GhNotifications>('notifs') ?? list(false))),
};

export const notificationsPost: Record<string, PostRoute> = {
  notifsRead: async (_, b) => {
    const id = threadId(b);
    await rest('PATCH', `/notifications/threads/${id}`);
    patch((x) => x === id, 'read');
    return {};
  },
  notifsDone: async (_, b) => {
    const id = threadId(b);
    await rest('DELETE', `/notifications/threads/${id}`);
    patch((x) => x === id, 'done');
    return {};
  },
  notifsUnsubscribe: async (_, b) => {
    const id = threadId(b);
    await rest('PUT', `/notifications/threads/${id}/subscription`, { ignored: true });
    await rest('DELETE', `/notifications/threads/${id}`);
    patch((x) => x === id, 'done');
    return {};
  },
  /** Everything up to what was shown (`before`, ms), in one repo or everywhere. */
  notifsReadAll: async (_, b) => {
    const before = typeof b?.before === 'number' ? b.before : Date.now();
    const repo = typeof b?.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(b.repo) ? b.repo : null;
    await rest('PUT', repo ? `/repos/${repo}/notifications` : '/notifications', { last_read_at: new Date(before).toISOString(), read: true });
    patch((id) => !!last?.result.items.some((n) => n.id === id && n.updatedAt <= before && (!repo || n.repo.toLowerCase() === repo.toLowerCase())), 'read');
    return {};
  },
};
