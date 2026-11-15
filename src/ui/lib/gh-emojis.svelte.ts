// GitHub's emoji shortcodes, asked for once GitHub's reachable (server/gh/emojis.ts): until then, or
// signed out, `:name:` shows as written.

import { gh, ghRequest } from './github.svelte.ts';
import type { Emojis } from '../../shared/gh-emojis.ts';

class EmojiNames {
  private map = $state.raw<Emojis | null>(null);
  private asked = -1;

  /** Ask for them, once per GitHub refresh until it works. */
  load() {
    if (this.map || !gh.ready || this.asked === gh.tick) return;
    this.asked = gh.tick;
    ghRequest<Emojis>('emojis').then(
      (m) => (this.map = m),
      () => {},
    );
  }

  /** What `:name:` shows: its emoji, `img:<url>` for one of GitHub's own, or null when it isn't one (or isn't known yet). */
  get(name: string): string | null {
    return this.map?.[name] ?? null;
  }
}

export const emojis = new EmojiNames();
