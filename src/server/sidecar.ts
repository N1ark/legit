// Server entry point for the desktop app, compiled into a standalone binary
// (scripts/build-sidecar.mjs). Usage: legit-server [repo] --dist <ui dir>
//
// Without a repo it's a spare, started ahead of need: it loads, then waits for the repo's path
// as the first line on stdin. Prints the URL once listening. Exits when stdin closes (the app
// closed the window, quit, or crashed), after letting any running operation finish.

import { parseArgs } from 'node:util';
import { Repo } from './repo.ts';
import { serve } from './server.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dist: { type: 'string' } },
});

/** The first line on stdin; exits if stdin closes first (a spare that was never used). */
function firstLine(): Promise<string> {
  return new Promise((done) => {
    let text = '';
    const onData = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const end = text.indexOf('\n');
      if (end < 0) return;
      process.stdin.off('data', onData).off('end', onEnd).pause();
      done(text.slice(0, end));
    };
    const onEnd = () => process.exit(0);
    process.stdin.on('data', onData).on('end', onEnd);
  });
}

let repo: Repo;
try {
  repo = await Repo.open(positionals[0] ?? (await firstLine()));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const { url } = await serve(repo, { port: 0, dist: values.dist! });
console.log(url);
// The app keeps stderr in a log: this says which run what follows is from.
console.error(`${new Date().toISOString()} serving ${repo.git.root}`);

process.stdin.on('end', async () => {
  await repo.idle();
  process.exit(0);
});
process.stdin.resume();
