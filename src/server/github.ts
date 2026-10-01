// Which GitHub repository a remote is, so the UI can link `#123` to its issues.

/** `owner/repo` of a github.com remote URL (https, ssh or scp-like), or null. */
export function githubRepo(url: string): string | null {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url) ??
    /^(?:[^@/]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The GitHub repository of `preferred` (the remote the branch pushes to), else of origin, else of
 * the first remote that is on GitHub.
 */
export function pickGithubRepo(remotes: Map<string, string>, preferred?: string): string | null {
  const order = [preferred, 'origin', ...remotes.keys()];
  for (const name of order) {
    const repo = name ? githubRepo(remotes.get(name) ?? '') : null;
    if (repo) return repo;
  }
  return null;
}
