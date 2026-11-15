// GitHub's eight reactions, in its picker's order, as emoji and as words (for labels and tooltips).

import type { Reaction } from '../../shared/gh-review.ts';

export const REACTIONS: Reaction[] = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'];

export const EMOJI: Record<Reaction, string> = {
  THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀',
};

export const REACTION_NAMES: Record<Reaction, string> = {
  THUMBS_UP: 'Thumbs up', THUMBS_DOWN: 'Thumbs down', LAUGH: 'Laugh', HOORAY: 'Hooray', CONFUSED: 'Confused', HEART: 'Heart', ROCKET: 'Rocket', EYES: 'Eyes',
};

/** Where an arrow key (or Home/End) moves from cell `i` of a grid `cols` wide holding `n`; null for other keys. */
export function gridStep(i: number, key: string, cols: number, n: number): number | null {
  const rows = Math.ceil(n / cols);
  const [r, c] = [Math.floor(i / cols), i % cols];
  const at = (row: number, col: number) => Math.min(n - 1, row * cols + col);
  switch (key) {
    case 'ArrowRight': return (i + 1) % n;
    case 'ArrowLeft': return (i - 1 + n) % n;
    case 'ArrowDown': return at((r + 1) % rows, c);
    case 'ArrowUp': return at((r - 1 + rows) % rows, c);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}
