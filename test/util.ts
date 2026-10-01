// Throwaway repos for tests: `setup()` registers hooks that give each test a fresh repo in `t.dir`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach } from 'node:test';

export const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x.org', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x.org',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

export function setup() {
  const dirs: string[] = [];
  const t = {
    dir: '',
    tmp(prefix = 'legit-test-') {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    gitIn: (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim(),
    git: (...args: string[]) => t.gitIn(t.dir, ...args),
    write: (f: string, s: string) => writeFileSync(join(t.dir, f), s),
    read: (f: string) => readFileSync(join(t.dir, f), 'utf8'),
    exists: (f: string) => existsSync(join(t.dir, f)),
    commit(msg: string, files: Record<string, string>) {
      for (const [f, s] of Object.entries(files)) t.write(f, s);
      t.git('add', '-A');
      t.git('commit', '-qm', msg);
      return t.git('rev-parse', 'HEAD');
    },
    /** A bare repo added as `origin`. */
    remote() {
      const remote = t.tmp('legit-remote-');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
      t.git('remote', 'add', 'origin', remote);
      return remote;
    },
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  beforeEach(() => {
    t.dir = t.tmp();
    t.git('init', '-q', '-b', 'main');
  });
  return t;
}
