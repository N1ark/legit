// GitHub's REST and GraphQL APIs, with the user's token. With LEGIT_GITHUB_MOCK set, every call
// goes to the in-memory fake in mock/ instead, so the UI can be worked on without GitHub (REST
// ones as HTTP answers, through the same ETags and rate-limit handling).

import { execFile } from 'node:child_process';
import https from 'node:https';
import zlib from 'node:zlib';
import { GitError } from '../git.ts';
import { log } from '../log.ts';
import { mockGraphql, mockResponse, mockRest } from './mock/registry.ts';

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
    const start = Date.now();
    const why: string[] = [];
    for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
      const t = await new Promise<string | null>((done) =>
        execFile(gh, ['auth', 'token', '--hostname', 'github.com'], { timeout: 3000 }, (err, out, stderr) => {
          const code = (err as { code?: string | number } | null)?.code;
          if (err) why.push(`${gh}: ${err.killed ? 'timed out' : typeof code === 'string' ? code : stderr.trim() || `exit ${code}`}`);
          done(err ? null : out.trim() || null);
        }),
      );
      if (t) {
        if (Date.now() - start > 1000) log(`GitHub token from gh took ${Date.now() - start}ms (${why.join('; ') || 'first try'})`);
        return t;
      }
    }
    log(`No GitHub token after ${Date.now() - start}ms (${why.join('; ')})`);
    return null;
  })();
  // No token yet (gh timed out, or isn't signed in): look again next time rather than for good.
  const asked = token;
  asked.then((t) => t === null && token === asked && resetToken());
  return asked;
}

/** Forget the token, so the next call looks again (after `gh auth login`, say). */
export function resetToken() {
  token = null;
}

const NO_TOKEN = 'Sign in to GitHub first: run `gh auth login`, or set GITHUB_TOKEN.';

async function headers(extra?: Record<string, string>): Promise<Record<string, string>> {
  const t = MOCK ? 'mock' : await githubToken();
  if (!t) throw new GithubError(NO_TOKEN, 401, 'github-auth');
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'legit',
    authorization: `Bearer ${t}`,
    ...extra,
  };
}

async function failure(res: Response, path: string): Promise<GithubError> {
  let message = res.statusText;
  try {
    const body = (await res.json()) as { message?: string; errors?: ({ message?: string } | string)[] };
    const details = (body.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message)).filter(Boolean);
    message = [body.message, ...details].filter(Boolean).join(': ') || message;
  } catch {}
  if (res.status === 401) return new GithubError(`GitHub refused the token (${message}). ${NO_TOKEN}`, 401, 'github-auth');
  const says = res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
  if ((res.status === 403 || res.status === 429) && (says || /rate limit/i.test(message))) {
    // A secondary limit that doesn't say for how long: GitHub asks for at least a minute.
    if (!says) pause('*', Date.now() + 60_000);
    return limitError(pausedUntil(path), res.status);
  }
  return new GithubError(`GitHub: ${message}`, res.status);
}

/** When each rate limit (`core`, `graphql`…, and `*` for a secondary one) lets requests through again. */
const paused = new Map<string, number>();
const resourceOf = (path: string) => (path === '/graphql' ? 'graphql' : path.startsWith('/search/') ? 'search' : 'core');
const pause = (resource: string, until: number) => paused.set(resource, Math.max(until, paused.get(resource) ?? 0));
const pausedUntil = (path: string) => Math.max(paused.get('*') ?? 0, paused.get(resourceOf(path)) ?? 0);

function limitError(until: number, status = 429): GithubError {
  const min = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return new GithubError(`GitHub rate-limited this token; try again in ${min > 1 ? `${min} minutes` : 'a minute'}.`, status, 'github-limit');
}

/** Each limit's warning was logged for the window ending then. */
const warned = new Map<string, number>();

/** Note what a response says of the rate limits: one used up, or a `retry-after`, holds the requests it covers until then. */
function noteLimits(path: string, res: Response) {
  const h = res.headers;
  const resource = h.get('x-ratelimit-resource') ?? resourceOf(path);
  const reset = Number(h.get('x-ratelimit-reset')) * 1000 || Date.now() + 60_000;
  const [left, limit] = [Number(h.get('x-ratelimit-remaining') ?? NaN), Number(h.get('x-ratelimit-limit') ?? NaN)];
  const after = Number(h.get('retry-after'));
  if (res.status >= 400 && after > 0) pause('*', Date.now() + after * 1000);
  if (left === 0) pause(resource, reset);
  else if (left < limit / 20 && warned.get(resource) !== reset) {
    warned.set(resource, reset);
    log(`GitHub rate limit (${resource}): ${left} of ${limit} left until ${new Date(reset).toLocaleTimeString()}`);
  }
}

/** Why a request failed, short: the error's code (ECONNRESET, ENOTFOUND…) where it has one. */
function networkReason(e: unknown): string {
  const err = e as { code?: string; name?: string; message?: string };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timed out';
  return err?.code ?? err?.message ?? String(e);
}

// Over HTTP/1.1 rather than fetch(): Node's fetch speaks HTTP/2 to GitHub, and after hours idle
// (the Mac asleep) it can hold on to a dead session and fail every request with
// ERR_HTTP2_INVALID_SESSION. A dead keep-alive socket is just dropped, and the retry gets a new one.
// GitHub closes a connection after ~30s idle, so one is kept for less than that.
const IDLE = 15_000;
const agent = new https.Agent({ keepAlive: true, maxSockets: 8, timeout: IDLE });

// Node's timers stand still while the Mac sleeps, so on waking the agent would still hand out
// connections dead for hours (each failing with ECONNRESET, or hanging until the timeout): their
// idle time is checked against the clock on the wall before each request instead.
const idleSince = new WeakMap<object, number>();
agent.on('free', (socket) => idleSince.set(socket, Date.now()));

/** Close pooled connections idle since before `before` (all of them by default). */
function dropIdle(before = Infinity) {
  for (const list of Object.values(agent.freeSockets)) {
    for (const s of list ?? []) if ((idleSince.get(s) ?? 0) < before) s.destroy();
  }
}

type Init = { method?: string; headers: Record<string, string>; body?: string };

function request(url: URL, init: Init, redirects = 0): Promise<Response> {
  return new Promise((done, fail) => {
    const req = https.request(url, {
      agent,
      method: init.method ?? 'GET',
      headers: { ...init.headers, 'accept-encoding': 'gzip' },
      signal: AbortSignal.timeout(30_000),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', fail);
      // Anything thrown in here (a garbled gzip body, say) would escape the promise and take the
      // whole server down, so it's turned into a failed request instead.
      res.on('end', () => {
        try {
          const status = res.statusCode ?? 0;
          // Job logs answer with a redirect to storage elsewhere, which mustn't get the token.
          if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
            const next = new URL(res.headers.location, url);
            const { authorization, ...rest } = init.headers;
            const headers = next.host === url.host ? init.headers : rest;
            done(request(next, { headers }, redirects + 1));
            return;
          }
          let body = Buffer.concat(chunks);
          if (res.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          done(new Response(status === 204 || status === 304 ? null : body, { status, statusText: res.statusMessage, headers: h }));
        } catch (e) {
          fail(e);
        }
      });
    });
    req.on('error', fail);
    req.end(init.body);
  });
}

/** A request taking longer than this is noted in the log. */
const SLOW = 5_000;

/** A GraphQL body's operation name, for the log. */
const queryName = (body?: string) => /\b(?:query|mutation)\s+(\w+)/.exec(body ?? '')?.[1] ?? 'anonymous';

/** A call to the API. A request that never got an answer (a pooled connection GitHub had
 *  closed, a blip after the Mac wakes) is sent once more when that can't do anything twice. */
async function send(path: string, init: Init, safe: boolean): Promise<Response> {
  const what = `GitHub ${init.method ?? 'GET'} ${path}${path === '/graphql' ? ` ${queryName(init.body)}` : ''}`;
  // Asking while rate-limited only fails again, and GitHub may ban a token that keeps at it.
  const until = pausedUntil(path);
  if (Date.now() < until) throw limitError(until);
  for (let attempt = 0; ; attempt++) {
    dropIdle(Date.now() - IDLE);
    const start = Date.now();
    try {
      const res = MOCK ? await mockResponse(path, init) : await request(new URL(`https://api.github.com${path}`), init);
      noteLimits(path, res);
      const ms = Date.now() - start;
      if (res.status >= 400) log(`${what}: ${res.status} after ${ms}ms`);
      else if (ms > SLOW) log(`${what}: took ${ms}ms`);
      return res;
    } catch (e) {
      log(`${what}: failed after ${Date.now() - start}ms (${networkReason(e)})`);
      // The other pooled connections most likely died the same way (the network changed): the
      // retry, and the requests after it, get new ones rather than one of those.
      dropIdle();
      const timedOut = (e as Error)?.name === 'AbortError' || (e as Error)?.name === 'TimeoutError';
      const again = attempt === 0 && !timedOut && safe;
      if (!again) throw new GithubError(`Couldn't reach GitHub (${networkReason(e)}).`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export interface RestOpts {
  /** Return the body as text (logs, diffs) rather than JSON. */
  text?: boolean;
  accept?: string;
  /** Doing it twice is harmless (a GraphQL query), so a dropped request may be resent. */
  safe?: boolean;
}

const inflight = new Map<string, Promise<unknown>>();

/** `fn()`, shared with an identical read still waiting for its answer (each joiner gets its own copy). */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const going = inflight.get(key) as Promise<T> | undefined;
  if (going) return going.then((v) => structuredClone(v));
  // Joiners copy it straight off `raw`, before the first caller (a tick later, on `raw.finally`) sees it.
  const raw = fn();
  inflight.set(key, raw);
  return raw.finally(() => inflight.get(key) === raw && inflight.delete(key));
}

/** A REST call, e.g. `rest('GET', '/repos/o/r/pulls?head=o:b')`; 204s return null. */
export function rest<T = any>(method: string, path: string, body?: unknown, opts: RestOpts = {}): Promise<T> {
  if (method !== 'GET') return restCall(method, path, body, opts);
  return once(`GET ${path}\0${opts.accept ?? ''}\0${!!opts.text}`, () => restCall<T>(method, path, body, opts));
}

/** REST GETs' last answers with their ETags, asked for again with `If-None-Match`: a 304 costs no rate limit. */
const etags = new Map<string, { etag: string; body: string }>();
const ETAGS = 200;
/** Bigger answers aren't kept. */
const ETAG_BODY = 256 * 1024;

async function restCall<T>(method: string, path: string, body: unknown, opts: RestOpts): Promise<T> {
  const key = method === 'GET' && !opts.text ? `${path}\0${opts.accept ?? ''}` : null;
  const hit = key ? etags.get(key) : undefined;
  const res = await send(path, {
    method,
    headers: await headers({
      ...(opts.accept ? { accept: opts.accept } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(hit ? { 'if-none-match': hit.etag } : {}),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  }, method === 'GET' || !!opts.safe);
  if (key && hit && res.status === 304) {
    // Most recently used last, so the oldest is the one dropped.
    etags.delete(key);
    etags.set(key, hit);
    return JSON.parse(hit.body) as T;
  }
  if (!res.ok) throw await failure(res, path);
  if (res.status === 204) return null as T;
  if (opts.text) return (await res.text()) as T;
  const text = await res.text();
  if (key) {
    etags.delete(key);
    const etag = res.headers.get('etag');
    if (etag && text.length <= ETAG_BODY) etags.set(key, { etag, body: text });
    if (etags.size > ETAGS) etags.delete(etags.keys().next().value!);
  }
  return JSON.parse(text) as T;
}

/** A GET sent with `If-Modified-Since`: null when nothing changed (a 304, which costs no rate limit). */
export async function restSince<T = any>(path: string, since: string | null): Promise<{ data: T; modified: string | null; poll: number } | null> {
  if (MOCK) return { data: (await mockRest('GET', path, undefined)) as T, modified: null, poll: 60 };
  const res = await send(path, { headers: await headers(since ? { 'if-modified-since': since } : {}) }, true);
  if (res.status === 304) return null;
  if (!res.ok) throw await failure(res, path);
  return { data: (await res.json()) as T, modified: res.headers.get('last-modified'), poll: Number(res.headers.get('x-poll-interval')) || 60 };
}

/** A GraphQL query or mutation; it must be named (`query Name(…)`), which is how the mock finds it. */
export function graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!/^\s*query\b/.test(query)) return graphqlCall(query, variables);
  return once(`${query}\0${JSON.stringify(variables)}`, () => graphqlCall<T>(query, variables));
}

async function graphqlCall<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (MOCK) return mockGraphql(query, variables) as T;
  const res = await rest<{ data?: T; errors?: { message: string; type?: string }[] }>('POST', '/graphql', { query, variables }, { safe: /^\s*query\b/.test(query) });
  if (res.errors?.length) {
    const msg = res.errors.map((e) => e.message).join('; ');
    log(`GitHub GraphQL ${queryName(query)}: ${msg}`);
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

/** How long a warmed answer waits for the request it was made for. */
const WARM = 10_000;
const warmed = new Map<string, { at: number; value: Promise<unknown> }>();

/** Start `fn()` ahead of a request the page is about to make (unless that's under way); failures aren't kept. */
export function warm<T>(key: string, fn: () => Promise<T>): Promise<unknown> {
  const hit = warmed.get(key);
  const value = hit && Date.now() - hit.at < WARM ? hit.value : fn();
  if (value !== hit?.value) warmed.set(key, { at: Date.now(), value });
  return value.catch(() => warmed.get(key)?.value === value && warmed.delete(key));
}

/** What `warm(key)` started, taken once: later requests ask GitHub again. */
export function takeWarm<T>(key: string): Promise<T> | undefined {
  const hit = warmed.get(key);
  warmed.delete(key);
  return hit && Date.now() - hit.at < WARM ? (hit.value as Promise<T>) : undefined;
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
