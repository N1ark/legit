// New issues (the dialog's state, its labels and assignees, creating one), and the diff's GitHub
// entries for lines: a permalink, or an issue about them.

import { type MaybeEntry, toast } from 'purr';
import { IssueOpenedRegular, LinkRegular } from 'purr/glyphs';
import { app } from './app.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import { blobUrl, lineSpan } from './gh-links.ts';
import type { CreatedIssue, IssueMeta, NewIssue } from '../../shared/gh-issues.ts';

export type IssueDraft = NewIssue;

const empty = (): IssueDraft => ({ title: '', body: '', labels: [], assignees: [] });

class IssueDialog {
  /** The dialog's starting values while it's open. */
  draft = $state.raw<IssueDraft | null>(null);
  /** What a dialog closed without creating had, offered again next time. */
  private kept: IssueDraft | null = null;

  close(left?: IssueDraft) {
    this.kept = left && (left.title.trim() || left.body.trim()) ? left : null;
    this.draft = null;
  }

  open(prefill?: Partial<IssueDraft>) {
    this.draft = prefill ? { ...empty(), ...prefill } : (this.kept ?? empty());
  }
}

export const issueDialog = new IssueDialog();

/** Open the new-issue dialog, with `prefill` (else what it had when last closed). */
export function openNewIssue(prefill?: Partial<IssueDraft>) {
  issueDialog.open(prefill);
}

/** Labels and assignable people, for the dialog. */
export const issueMeta = () => ghRequest<IssueMeta>('issuesMeta');

/** Create the issue; true once it's made (the toast offers to open it). */
export async function createIssue(draft: IssueDraft): Promise<boolean> {
  try {
    const made = await ghPost<CreatedIssue>('issuesCreate', draft);
    toast(`Opened #${made.number}`, { action: { label: 'View on GitHub', run: () => app.openUrl(made.url) } });
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  }
}

/** A diff's GitHub entries for some new-side `lines` of `path` in commit `sha` (nothing unless it's a listed commit of a GitHub repo). */
export function lineEntries(sha: string, path: string, lines: number[]): MaybeEntry[] {
  const c = app.bySha.get(sha);
  const repo = app.repo?.github;
  if (!c || !repo) return [];
  const span = lineSpan(lines);
  const url = blobUrl(repo, sha, path, span);
  const unpushed = c.pushed ? null : "This commit isn't pushed, so GitHub doesn't have it.";
  const one = !span || span[0] === span[1];
  return [
    {
      label: 'Copy GitHub link',
      icon: LinkRegular,
      disabled: !!unpushed,
      note: unpushed ?? (span ? (one ? `To line ${span[0]}` : `To lines ${span[0]}–${span[1]}`) : undefined),
      run: () => app.copy(url, 'GitHub link'),
    },
    {
      label: one ? 'New issue from this line…' : 'New issue from these lines…',
      icon: IssueOpenedRegular,
      disabled: !!unpushed || !gh.ready,
      note: unpushed ?? (gh.ready ? 'GitHub shows the lines in it' : (gh.status?.error ?? undefined)),
      run: () => openNewIssue({ body: `${url}\n\n` }),
    },
  ];
}
