/**
 * A title for the commit split out of one titled `subject`: it, naming the picked files when
 * there are one or two of them (by file name), else marked as split.
 */
export function splitTitle(subject: string, paths: string[]): string {
  const title = subject.trim() || 'Changes';
  const names = [...new Set(paths.map((p) => p.slice(p.lastIndexOf('/') + 1)))];
  return `${title} (${names.length && names.length <= 2 ? names.join(', ') : 'split'})`;
}
