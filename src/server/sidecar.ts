// Server entry point for the desktop app, compiled into a standalone binary
// (scripts/build-sidecar.mjs). Usage: legit-server <repo> --dist <ui dir>
//
// Prints the URL once listening. Exits when stdin closes (the app closed the window,
// quit, or crashed), after letting any running operation finish.

import { parseArgs } from 'node:util';
import { Repo } from './repo.ts';
import { serve } from './server.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dist: { type: 'string' } },
});

let repo: Repo;
try {
  repo = await Repo.open(positionals[0] ?? '.');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const { url } = await serve(repo, { port: 0, dist: values.dist! });
console.log(url);

process.stdin.on('end', async () => {
  await repo.idle();
  process.exit(0);
});
process.stdin.resume();
