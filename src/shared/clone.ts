// What a clone of a URL (or GitHub's `owner/name`) is cloned from and named: for the server, and the dialog's placeholder.

const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

/** The URL to clone: `url` as given, or GitHub's for `owner/name`. */
export function cloneUrl(url: string, ssh: boolean): string {
  const u = url.trim();
  if (!SHORTHAND.test(u)) return u;
  const name = u.replace(/\.git$/, '');
  return ssh ? `git@github.com:${name}.git` : `https://github.com/${name}.git`;
}

/** The folder a clone of `url` gets by default, as git names it: the URL's last part, without `.git`. */
export function cloneName(url: string): string {
  return (
    url
      .trim()
      .replace(/[\\/]+$/, '')
      .replace(/\.git$/, '')
      .split(/[\\/:]/)
      .pop() ?? ''
  );
}
