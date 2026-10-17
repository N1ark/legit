// Types shared between the server and the UI for the GitHub integration (server/gh/).

export interface GhUser {
  login: string;
  avatar: string;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';

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
}
