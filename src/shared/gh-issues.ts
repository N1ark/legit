// Issues and `#123` references on GitHub (server/gh/issues.ts).

import type { GhUser, PrState } from './github.ts';

/** An issue is open or closed; a pull request any of its states. */
export type RefState = PrState;

/** What `#123` or `owner/repo#123` points at. */
export interface IssueRef {
  /** `owner/repo` it's in. */
  repo: string;
  number: number;
  title: string;
  state: RefState;
  isPullRequest: boolean;
  /** A closed issue that won't be done, rather than a completed one. */
  notPlanned: boolean;
  author: GhUser | null;
  url: string;
}

export interface IssueLabel {
  name: string;
  /** Hex without `#`, as GitHub stores it. */
  color: string;
  description: string | null;
}

/** What a new issue can be given in the repository. */
export interface IssueMeta {
  repo: string;
  labels: IssueLabel[];
  assignees: GhUser[];
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}
