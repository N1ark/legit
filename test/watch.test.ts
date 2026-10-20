import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Repo } from '../src/server/repo.ts';
import { serve } from '../src/server/server.ts';
import { setup } from './util.ts';

const t = setup();

/** The events the server sends while `fn` runs, and a moment after. */
async function eventsDuring(url: string, fn: () => void): Promise<string[]> {
  const res = await fetch(new URL('/api/events', url));
  const reader = res.body!.getReader();
  const events: string[] = [];
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      events.push(...[...Buffer.from(value).toString().matchAll(/^data: (\w+)$/gm)].map((m) => m[1]));
    }
  })();
  await sleep(200);
  fn();
  await sleep(900);
  await reader.cancel();
  await reading.catch(() => {});
  return events;
}

test('changes to ignored files tell the page nothing; to a tracked file inside an ignored folder, they do', async () => {
  mkdirSync(join(t.dir, 'out'));
  t.commit('one', { f: '1\n', '.gitignore': 'out/\n' });
  t.write('out/kept', 'k\n');
  t.git('add', '-f', 'out/kept');
  t.git('commit', '-qm', 'kept');
  const s = await serve(await Repo.open(t.dir), { port: 0, dist: t.tmp() });
  try {
    await sleep(300);
    assert.deepEqual(await eventsDuring(s.url, () => t.write('out/build.js', 'x\n')), []);
    assert.deepEqual(await eventsDuring(s.url, () => t.write('f', '2\n')), ['work']);
    assert.deepEqual(await eventsDuring(s.url, () => t.write('out/kept', 'changed\n')), ['work']);
    assert.deepEqual(await eventsDuring(s.url, () => t.write('new', 'n\n')), ['work']);
  } finally {
    s.close();
  }
});
