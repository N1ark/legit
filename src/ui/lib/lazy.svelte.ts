// Views the first screen doesn't show, kept out of the bundle the page boots with (loaded when shown, or by `preload`).

import type { Component } from 'svelte';

export interface Lazy<C> {
  /** The component once loaded; reading it starts loading it. */
  readonly component: C | null;
  load(): Promise<unknown>;
}

const all: Lazy<unknown>[] = [];

export function lazy<C extends Component<any, any, any>>(load: () => Promise<{ default: C }>): Lazy<C> {
  let loaded = $state.raw<C | null>(null);
  let loading: Promise<unknown> | null = null;
  const start = () =>
    (loading ??= load().then(
      (m) => (loaded = m.default),
      (e) => {
        loading = null;
        throw e;
      },
    ));
  const view: Lazy<C> = {
    get component() {
      if (!loaded) void start();
      return loaded;
    },
    load: start,
  };
  all.push(view);
  return view;
}

/** Load every lazy view once the first screen has settled, one at a time when idle, so none waits when first shown. */
export function preload() {
  const idle = (run: () => void) =>
    'requestIdleCallback' in window ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 50);
  const next = (i: number) => {
    if (i < all.length) idle(() => all[i].load().catch(() => {}).finally(() => next(i + 1)));
  };
  setTimeout(() => next(0), 2000);
}
