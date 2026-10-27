import assert from 'node:assert/strict';
import fs, { type FSWatcher, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
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

test('folders made after the server started are watched too, and commits from a terminal are seen', async () => {
  t.commit('one', { f: '1\n' });
  const s = await serve(await Repo.open(t.dir), { port: 0, dist: t.tmp() });
  try {
    await sleep(300);
    assert.deepEqual(await eventsDuring(s.url, () => mkdirSync(join(t.dir, 'a/b'), { recursive: true })), ['work']);
    assert.deepEqual(await eventsDuring(s.url, () => t.write('a/b/c', 'c\n')), ['work']);
    assert.deepEqual(await eventsDuring(s.url, () => t.write('a/b/c', 'changed\n')), ['work']);
    assert.ok((await eventsDuring(s.url, () => t.commit('two', { f: '2\n' }))).includes('change'));
  } finally {
    s.close();
  }
});

test("when watching fails (out of watches), the server keeps going and tells the page it can't see changes", async () => {
  t.commit('one', { f: '1\n' });
  const made: FSWatcher[] = [];
  const real = fs.watch;
  mock.method(fs, 'watch', (...args: Parameters<typeof fs.watch>) => {
    const w = real(...args);
    made.push(w);
    return w;
  });
  syncBuiltinESMExports();
  try {
    const s = await serve(await Repo.open(t.dir), { port: 0, dist: t.tmp() });
    try {
      await sleep(300);
      assert.ok(made.length);
      const fail = Object.assign(new Error('watch ENOSPC'), { code: 'ENOSPC' });
      assert.deepEqual(await eventsDuring(s.url, () => made.at(-1)!.emit('error', fail)), ['blind']);
      assert.equal((await fetch(new URL('/api/state', s.url))).status, 200);
      // A page that connects later is told too.
      assert.deepEqual(await eventsDuring(s.url, () => {}), ['blind']);
    } finally {
      s.close();
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
