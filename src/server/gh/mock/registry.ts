// The fake GitHub behind LEGIT_GITHUB_MOCK: handlers registered by name (GraphQL) or route (REST),
// over one shared in-memory `db` that mutations change, so the UI sees its own writes.

import { GithubError } from '../client.ts';

type GraphqlHandler = (vars: Record<string, any>) => unknown | Promise<unknown>;
type RestHandler = (params: Record<string, string>, query: URLSearchParams, body: any) => unknown | Promise<unknown>;

const graphqlHandlers = new Map<string, GraphqlHandler>();
const restHandlers: { method: string; pattern: RegExp; keys: string[]; fn: RestHandler }[] = [];

/** Shared fake state; each fixture module keeps its own part under its own key. */
export const db: Record<string, any> = {};
/** The local repo's branch tips by name (origin's included as `origin/x`), refreshed before each call. */
db.tips = {} as Record<string, string>;

/** Answer the GraphQL operation called `name` (`query Name(…)` / `mutation Name(…)`). */
export function onGraphql(name: string, fn: GraphqlHandler) {
  graphqlHandlers.set(name, fn);
}

/** Answer e.g. `GET /repos/:owner/:repo/pulls/:number`; params are the `:x` parts. */
export function onRest(route: string, fn: RestHandler) {
  const [method, path] = route.split(' ');
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  restHandlers.push({ method, pattern, keys, fn });
}

/** Every call answered, `GraphQL Name` or `GET /path`, oldest first: what tests count. */
export const mockCalls: string[] = [];

const latency = () => new Promise((r) => setTimeout(r, 150 + Math.random() * 250));

export async function mockGraphql(query: string, vars: Record<string, unknown>): Promise<unknown> {
  const name = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
  mockCalls.push(`GraphQL ${name}`);
  await latency();
  const fn = graphqlHandlers.get(name);
  if (!fn) throw new GithubError(`GitHub mock: no handler for GraphQL operation "${name}".`, 500);
  return structuredClone(await fn(vars));
}

export async function mockRest(method: string, path: string, body: unknown): Promise<unknown> {
  const url = new URL(path, 'https://api.github.com');
  mockCalls.push(`${method} ${url.pathname}`);
  await latency();
  for (const h of restHandlers) {
    const m = h.method === method ? h.pattern.exec(url.pathname) : null;
    if (!m) continue;
    const params = Object.fromEntries(h.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return structuredClone((await h.fn(params, url.searchParams, body)) ?? null);
  }
  throw new GithubError(`GitHub mock: no handler for ${method} ${url.pathname}.`, 404);
}
