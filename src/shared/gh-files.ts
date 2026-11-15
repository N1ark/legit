// Types shared between the server and the UI for keeping track during a review: which of a pull
// request's files the viewer marked viewed (server/gh/prfiles.ts).

/** GitHub's per-file mark: `DISMISSED` when the file changed since it was marked viewed. */
export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';

export interface PrFiles {
  number: number;
  headSha: string;
  viewer: string;
  /** Each of the pull request's files' mark, by path. */
  viewed: Record<string, ViewedState>;
}
