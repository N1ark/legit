// GitHub's REST and GraphQL APIs, with the user's token. With LEGIT_GITHUB_MOCK set, every call
// goes to the in-memory fake in mock/ instead, so the UI can be worked on without GitHub.

import { execFile } from 'node:child_process';
import { GitError } from '../git.ts';
import { mockGraphql, mockRest } from './mock/registry.ts';

export const MOCK = !!process.env.LEGIT_GITHUB_MOCK;

/** Codes the UI acts on: 'github-auth' (no token, or GitHub refused it), 'github-limit' (rate-limited). */
export class GithubError extends GitError {
  status: number;
  constructor(message: string, status = 0, code?: string) {
    super(message, code);
    this.status = status;
  }
}

let token: Promise<string | null> | null = null;

/** GITHUB_TOKEN / GH_TOKEN, else the gh CLI's login. */
export function githubToken(): Promise<string | null> {
  token ??= (async () => {
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env) return env;
    for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
      const t = await new Promise<string | null>((done) =>
        execFile(gh, ['auth', 'token', '--hostname', 'github.com'], { timeout: 3000 }, (err, out) =>
          done(err ? null : out.trim() || null),
        ),
      );
      if (t) return t;
    }
    return null;
  })();
  return token;
}

/** Forget the token, so the next call looks again (after `gh auth login`, say). */
export function resetToken() {
  token = null;
}

const NO_TOKEN = 'Sign in to GitHub first: run `gh auth login`, or set GITHUB_TOKEN.';

async function headers(extra?: Record<string, string>): Promise<Record<string, string>> {
  const t = await githubToken();
  if (!t) throw new GithubError(NO_TOKEN, 401, 'github-auth');
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'legit',
    authorization: `Bearer ${t}`,
    ...extra,
  };
}

async function failure(res: Response): Promise<GithubError> {
  let message = res.statusText;
  try {
    const body = (await res.json()) as { message?: string; errors?: ({ message?: string } | string)[] };
    const details = (body.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message)).filter(Boolean);
    message = [body.message, ...details].filter(Boolean).join(': ') || message;
  } catch {}
  if (res.status === 401) return new GithubError(`GitHub refused the token (${message}). ${NO_TOKEN}`, 401, 'github-auth');
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return new GithubError('GitHub rate-limited this token; try again in a few minutes.', res.status, 'github-limit');
  }
  return new GithubError(`GitHub: ${message}`, res.status);
}

export interface RestOpts {
  /** Return the body as text (logs, diffs) rather than JSON. */
  text?: boolean;
  accept?: string;
}

/** A REST call, e.g. `rest('GET', '/repos/o/r/pulls?head=o:b')`; 204s return null. */
export async function rest<T = any>(method: string, path: string, body?: unknown, opts: RestOpts = {}): Promise<T> {
  if (MOCK) return mockRest(method, path, body) as T;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: await headers({
        ...(opts.accept ? { accept: opts.accept } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e instanceof GithubError) throw e;
    throw new GithubError(`Couldn't reach GitHub (${e instanceof Error ? e.message : e}).`);
  }
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return null as T;
  return (opts.text ? await res.text() : await res.json()) as T;
}

/** A GraphQL query or mutation; it must be named (`query Name(…)`), which is how the mock finds it. */
export async function graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (MOCK) return mockGraphql(query, variables) as T;
  const res = await rest<{ data?: T; errors?: { message: string; type?: string }[] }>('POST', '/graphql', { query, variables });
  if (res.errors?.length) {
    const msg = res.errors.map((e) => e.message).join('; ');
    throw new GithubError(`GitHub: ${msg}`, 200, res.errors.some((e) => e.type === 'RATE_LIMITED') ? 'github-limit' : undefined);
  }
  return res.data as T;
}

/** The login of the token's owner. */
let viewer: Promise<string> | null = null;
export function viewerLogin(): Promise<string> {
  viewer ??= graphql<{ viewer: { login: string } }>('query Viewer { viewer { login } }').then((d) => d.viewer.login);
  viewer.catch(() => (viewer = null));
  return viewer;
}

/** `fn()`'s result for `ms`, per key; failures aren't kept. */
export function cached<T>(store: Map<string, { at: number; value: Promise<T> }>, key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = fn();
  store.set(key, { at: Date.now(), value });
  value.catch(() => store.get(key)?.value === value && store.delete(key));
  return value;
}
