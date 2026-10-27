// Types shared between the server and the UI for the GitHub integration (server/gh/).

export interface GhUser {
  login: string;
  avatar: string;
}

/** `queued`: open, and waiting in the base branch's merge queue. */
export type PrState = 'open' | 'draft' | 'queued' | 'merged' | 'closed';

/** Not merged or closed yet. */
export const isLive = (s: PrState) => s === 'open' || s === 'draft' || s === 'queued';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PrState;
  /** Branch it merges into, and the branch it's from (names on GitHub). */
  base: string;
  head: string;
  /** The head branch's tip, as GitHub has it. */
  headSha: string;
  author: GhUser | null;
  /** `owner/repo` the pull request is in. */
  repo: string;
}

export interface GithubStatus {
  /** `owner/repo` pull requests are opened against (the `upstream` remote's, else the push remote's); null if not on GitHub. */
  repo: string | null;
  /** `owner` of the repo branches are pushed to (a fork's, when there's one). */
  headOwner: string | null;
  /** The token's user; null when signed out (or GitHub couldn't be reached). */
  login: string | null;
  /** Why `login` is null, when it is. */
  error: string | null;
  /** The pull request of the branch asked about, when the server has it at hand. */
  pr?: PullRequest | null;
}
