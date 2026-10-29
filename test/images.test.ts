import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { serve } from '../src/server/server.ts';
import type { DiffSummary, WorkState } from '../src/shared/types.ts';
import { setup } from './util.ts';

const t = setup();
const { git } = t;
const png = (n: number) => Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(n)]);

async function server() {
  const repo = await Repo.open(t.dir);
  const s = await serve(repo, { port: 0, dist: t.tmp() });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, s.url), { headers });
  return { ...s, get };
}

test('binary files and images: sizes in the summary, images served at each side', async () => {
  writeFileSync(join(t.dir, 'logo.png'), png(100));
  writeFileSync(join(t.dir, 'data.bin'), png(10));
  git('add', '-A');
  git('commit', '-qm', 'base');
  writeFileSync(join(t.dir, 'logo.png'), png(200));
  writeFileSync(join(t.dir, 'data.bin'), png(20));
  git('add', '-A');
  git('commit', '-qm', 'change');
  const sha = git('rev-parse', 'HEAD');
  const s = await server();
  try {
    const d: DiffSummary = await (await s.get(`/api/diff/${sha}`)).json();
    const sizes = Object.fromEntries(d.files.map((f) => [f.path, [f.oldSize, f.newSize]]));
    assert.deepEqual(sizes, { 'data.bin': [18, 28], 'logo.png': [108, 208] });
    const i = d.files.findIndex((f) => f.path === 'logo.png');

    const old = await s.get(`/api/diff/${sha}/image?i=${i}&side=old`);
    assert.equal(old.status, 200);
    assert.equal(old.headers.get('content-type'), 'image/png');
    assert.equal(old.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(old.headers.get('content-security-policy')!, /sandbox/);
    assert.equal((await old.arrayBuffer()).byteLength, 108);
    assert.equal((await (await s.get(`/api/diff/${sha}/image?i=${i}&side=new`)).arrayBuffer()).byteLength, 208);

    // Another site's page can't embed it, and only images are served.
    assert.equal((await s.get(`/api/diff/${sha}/image?i=${i}`, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await s.get(`/api/diff/${sha}/image?i=${1 - i}`)).status, 404);

    // Uncommitted: the new side is the file on disk; an untracked image has no old side.
    writeFileSync(join(t.dir, 'logo.png'), png(300));
    writeFileSync(join(t.dir, 'new.png'), png(5));
    const w: WorkState = await (await s.get('/api/work')).json();
    const files = w.changes.files;
    const k = files.findIndex((f) => f.path === 'logo.png');
    const n = files.findIndex((f) => f.path === 'new.png');
    assert.deepEqual([files[k].oldSize, files[k].newSize], [208, 308]);
    assert.deepEqual([files[n].oldSize, files[n].newSize], [undefined, 13]);
    assert.equal((await (await s.get(`/api/diff/${w.changes.sha}/image?i=${k}&side=new`)).arrayBuffer()).byteLength, 308);
    assert.equal((await s.get(`/api/diff/${w.changes.sha}/image?i=${n}&side=old`)).status, 404);
  } finally {
    s.close();
  }
});

test("files' whole texts to render: each side, uncommitted ones from disk, documents only so big", async () => {
  writeFileSync(join(t.dir, 'notes.md'), '# Notes\n');
  writeFileSync(join(t.dir, 'gone.csv'), 'a,b\n1,2\n');
  git('add', '-A');
  git('commit', '-qm', 'texts');
  writeFileSync(join(t.dir, 'notes.md'), '# Notes\n\nMore.\n');
  git('rm', '-q', 'gone.csv');
  writeFileSync(join(t.dir, 'big.md'), 'x'.repeat(600 * 1024));
  writeFileSync(join(t.dir, 'big.csv'), 'y'.repeat(600 * 1024));
  git('add', '-A');
  git('commit', '-qm', 'more');
  const sha = git('rev-parse', 'HEAD');
  const s = await server();
  try {
    const d: DiffSummary = await (await s.get(`/api/diff/${sha}`)).json();
    const at = (path: string) => d.files.findIndex((f) => f.path === path);
    const text = async (key: string, i: number, side: string) => {
      const r = await s.get(`/api/diff/${key}/text?i=${i}&side=${side}`);
      return r.ok ? ((await r.json()) as { text: string }).text : r.status;
    };
    assert.equal(await text(sha, at('notes.md'), 'old'), '# Notes\n');
    assert.equal(await text(sha, at('notes.md'), 'new'), '# Notes\n\nMore.\n');
    assert.equal(await text(sha, at('gone.csv'), 'old'), 'a,b\n1,2\n');
    assert.equal(await text(sha, at('gone.csv'), 'new'), 404);
    // A document is laid out whole, so past a size it isn't rendered; a table only shows some of its rows.
    assert.equal(await text(sha, at('big.md'), 'new'), 413);
    assert.equal(((await text(sha, at('big.csv'), 'new')) as string).length, 600 * 1024);

    writeFileSync(join(t.dir, 'notes.md'), '# Notes\n\nOn disk.\n');
    const w: WorkState = await (await s.get('/api/work')).json();
    const k = w.changes.files.findIndex((f) => f.path === 'notes.md');
    assert.equal(await text(w.changes.sha, k, 'new'), '# Notes\n\nOn disk.\n');
    assert.equal(await text(w.changes.sha, k, 'old'), '# Notes\n\nMore.\n');
  } finally {
    s.close();
  }
});
