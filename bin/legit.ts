#!/usr/bin/env node
// legit [path] [--browser] [--port N] [--no-open] [--dev]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Repo } from '../src/server/repo.ts';
import { serve } from '../src/server/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p', default: '0' },
    'no-open': { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false },
    browser: { type: 'boolean', short: 'b', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`usage: legit [path] [--browser] [--port N] [--no-open]

Opens a UI to edit, split, squash and reorder the commits of the repository at
[path] (default: current directory): in Legit.app when it's installed, otherwise
(or with --browser) in the browser.`);
  process.exit(0);
}

let repo: Repo;
try {
  repo = await Repo.open(resolve(positionals[0] ?? '.'));
  const app = ['/Applications', join(homedir(), 'Applications')].map((d) => join(d, 'Legit.app')).find(existsSync);
  if (app && !values.browser && !values.dev) {
    // -n starts a fresh process; the running app (if any) takes over its argument and it exits.
    spawn('open', ['-n', '-a', app, '--args', repo.git.root], { stdio: 'ignore' }).on('exit', (code) => process.exit(code ?? 0));
    await new Promise(() => {});
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const root = join(here, '..');
if (!values.dev && !existsSync(join(root, 'dist', 'index.html'))) {
  console.error(`The UI isn't built yet: run \`npm run build\` in ${root}`);
  process.exit(1);
}
let dev;
if (values.dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true } });
  dev = vite.middlewares;
}

const { url } = await serve(repo, {
  port: Number(values.port),
  dist: join(root, 'dist'),
  dev,
});
console.log(`legit · ${repo.git.root}\n${url}`);

if (!values['no-open']) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
