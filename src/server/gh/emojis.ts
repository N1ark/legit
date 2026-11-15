// GitHub's emoji shortcodes for the page's markdown (shared/gh-emojis.ts).

import { cached, rest } from './client.ts';
import type { GetRoute } from './routes.ts';
import { type Emojis, toEmojis } from '../../shared/gh-emojis.ts';

const store = new Map<string, { at: number; value: Promise<Emojis> }>();

export const emojisGet: Record<string, GetRoute> = {
  // The same for every repository and seldom changed: asked for once a day.
  emojis: () => cached(store, 'all', 86_400_000, async () => toEmojis(await rest<Record<string, string>>('GET', '/emojis'))),
};
