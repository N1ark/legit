// Author avatars from GitHub. GitHub no-reply emails map straight to an avatar; other emails
// are looked up as commit authors in the repo's own GitHub remote (the API links a commit's
// email to its account). Emails are only ever sent to api.github.com, and only for repos
// hosted there. Results are cached on disk, so each email is looked up at most once a month.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Git } from './git.ts';

type Entry = { url: string | null; at: number };

const CACHE_FILE =
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/legit/avatars.json')
    : join(homedir(), '.cache/legit/avatars.json');
const HIT_TTL = 30 * 24 * 3600 * 1000;
const MISS_TTL = 7 * 24 * 3600 * 1000;
const PARALLEL = 4;

const NOREPLY = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i;
const GITHUB_REMOTE = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

let cache: Promise<Map<string, Entry>> | null = null;
let saveTimer: NodeJS.Timeout | undefined;
let token: Promise<string | null> | null = null;
/** Set when GitHub rate-limits us; lookups pause until then. */
let limitedUntil = 0;

function loadCache() {
  cache ??= readFile(CACHE_FILE, 'utf8')
    .then((s) => new Map<string, Entry>(Object.entries(JSON.parse(s))))
    .catch(() => new Map<string, Entry>());
  return cache;
}

function saveCache(map: Map<string, Entry>) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(map)));
  }, 500);
}

/** GITHUB_TOKEN / GH_TOKEN, else the gh CLI's login (read-only use: looking up commits). */
function githubToken(): Promise<string | null> {
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

/** owner/repo of the first github.com remote (origin preferred). */
async function githubRepo(git: Git): Promise<string | null> {
  const remotes = (await git.text(['remote'], { allowFail: true })).split('\n').filter(Boolean);
  remotes.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const r of remotes) {
    const url = await git.text(['remote', 'get-url', r], { allowFail: true });
    const m = GITHUB_REMOTE.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/** undefined: couldn't ask (rate limit, network); null: GitHub doesn't know this email. */
async function lookup(repo: string, email: string): Promise<string | null | undefined> {
  if (Date.now() < limitedUntil) return undefined;
  const t = await githubToken();
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits?author=${encodeURIComponent(email)}&per_page=1`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'legit',
          ...(t ? { authorization: `Bearer ${t}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      limitedUntil = reset ? reset * 1000 : Date.now() + 10 * 60_000;
      return undefined;
    }
    if (!res.ok) return res.status === 404 || res.status === 422 ? null : undefined;
    const commits = (await res.json()) as { author?: { avatar_url?: string } | null }[];
    return commits[0]?.author?.avatar_url ?? null;
  } catch {
    return undefined;
  }
}

export async function avatars(git: Git, emails: string[]): Promise<Record<string, string | null>> {
  const map = await loadCache();
  const out: Record<string, string | null> = {};
  const todo: string[] = [];
  const now = Date.now();
  for (const raw of new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))) {
    const noreply = NOREPLY.exec(raw);
    if (noreply) {
      out[raw] = noreply[1]
        ? `https://avatars.githubusercontent.com/u/${noreply[1]}?v=4`
        : `https://github.com/${noreply[2]}.png`;
      continue;
    }
    const hit = map.get(raw);
    if (hit && now - hit.at < (hit.url ? HIT_TTL : MISS_TTL)) out[raw] = hit.url;
    else todo.push(raw);
  }
  const repo = todo.length ? await githubRepo(git) : null;
  if (!repo) {
    for (const e of todo) out[e] = map.get(e)?.url ?? null;
    return out;
  }
  let changed = false;
  for (let k = 0; k < todo.length; k += PARALLEL) {
    await Promise.all(
      todo.slice(k, k + PARALLEL).map(async (e) => {
        const url = await lookup(repo, e);
        if (url === undefined) {
          out[e] = map.get(e)?.url ?? null;
          return;
        }
        out[e] = url;
        map.set(e, { url, at: Date.now() });
        changed = true;
      }),
    );
  }
  if (changed) saveCache(map);
  return out;
}
