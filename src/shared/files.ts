// What kind of file a diff shows, by its name, and sizes as people read them.

const IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** The image type of a file a browser can show, by its extension; null for anything else. */
export function imageType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? (IMAGES[path.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** 950 B, 12.3 KB, 4.0 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(1)} ${units[u]}`;
}
