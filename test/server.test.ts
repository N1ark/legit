import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { serve } from '../src/server/server.ts';
import { setup } from './util.ts';

const t = setup();

test("requests that make no sense are refused as such: a body that isn't JSON, a name every object has", async () => {
  t.commit('one', { f: '1\n' });
  const s = await serve(await Repo.open(t.dir), { port: 0, dist: t.tmp() });
  const post = (path: string, body: string) => fetch(new URL(path, s.url), { method: 'POST', headers: { 'x-legit': '1', 'content-type': 'application/json' }, body });
  try {
    const bad = await post('/api/undo', '{nope');
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /isn't JSON/);
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      assert.equal((await post(`/api/${name}`, '{}')).status, 404, name);
      const gh = await post(`/api/gh/${name}`, '{}');
      assert.match(((await gh.json()) as { error: string }).error, /No GitHub route/, `gh ${name}`);
    }
    // A real one still answers.
    assert.equal((await post('/api/undo', '{}')).status, 409);
  } finally {
    s.close();
  }
});

test('the CLI says what --port takes, without a stack trace', () => {
  for (const port of ['abc', '70000', '-1', '8080x']) {
    const r = spawnSync(process.execPath, ['bin/legit.ts', '--browser', '--no-open', `--port=${port}`, '.'], { encoding: 'utf8' });
    assert.equal(r.status, 1, port);
    assert.equal(r.stderr.trim(), `--port takes a port number from 0 to 65535, not "${port}".`);
  }
});
