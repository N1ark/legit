// GitHub's emoji shortcodes (`:+1:`, `:tada:`): most are Unicode, which GitHub's image URLs spell out
// (`…/unicode/1f44d.png`); a few of its own (`:octocat:`) are only images.

/** Shortcode name → the emoji's text, or `img:<url>` for an image-only one. */
export type Emojis = Record<string, string>;

/** The emoji an image URL of GitHub's spells (`1f1fa-1f1f8.png` → 🇺🇸), or null for an image-only one. */
export function emojiOfUrl(url: string): string | null {
  const m = /\/unicode\/([0-9a-f]+(?:-[0-9a-f]+)*)\.png/i.exec(url);
  if (!m) return null;
  try {
    return String.fromCodePoint(...m[1].split('-').map((h) => parseInt(h, 16)));
  } catch {
    return null;
  }
}

/** GET /emojis's list (name → image URL) as names → what they show. */
export function toEmojis(list: Record<string, string>): Emojis {
  const out: Emojis = {};
  for (const [name, url] of Object.entries(list)) out[name] = emojiOfUrl(url) ?? `img:${url}`;
  return out;
}
