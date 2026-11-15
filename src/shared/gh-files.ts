// Types shared between the server and the UI for keeping track during a review: which of a pull
// request's files the viewer marked viewed, its CODEOWNERS (server/gh/prfiles.ts), and CI's
// annotations on its head's lines (server/gh/annotations.ts).

/** GitHub's per-file mark: `DISMISSED` when the file changed since it was marked viewed. */
export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';

export interface PrFiles {
  number: number;
  headSha: string;
  viewer: string;
  /** Each of the pull request's files' mark, by path. */
  viewed: Record<string, ViewedState>;
  /** The base branch's CODEOWNERS (the first of GitHub's three places that has one), or null. */
  codeowners: { path: string; text: string } | null;
}

export type AnnotationLevel = 'notice' | 'warning' | 'failure';

export interface Annotation {
  /** Unique within the commit. */
  key: string;
  path: string;
  /** New-side lines it's on. */
  startLine: number;
  endLine: number;
  level: AnnotationLevel;
  title: string | null;
  message: string;
  details: string | null;
  /** The check run it's from, and where to see it. */
  check: string;
  url: string | null;
}

export interface CommitAnnotations {
  sha: string;
  annotations: Annotation[];
}
