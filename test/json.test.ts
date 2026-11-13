import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonError, members, pathOf, pretty, readJson, scalar } from '../src/ui/lib/json.ts';

const TEXT = `{
  // settings
  "name": "demo",
  "n": -1.5e3,
  "nested": {
    "list": [1, true, null, {"deep": "a\\"b"}],
    /* none */ "empty": {}
  },
  "tags": ["x", "y",],
}
`;

test('a value and its members, with where they are; comments and trailing commas are passed over', () => {
  const top = readJson(TEXT);
  assert.deepEqual([top.kind, top.line, top.last], ['object', 1, 10]);
  const m = members(TEXT, top);
  assert.deepEqual(m.map((x) => [x.key, x.kind, x.line, x.last]), [
    ['name', 'string', 3, 3],
    ['n', 'number', 4, 4],
    ['nested', 'object', 5, 8],
    ['tags', 'array', 9, 9],
  ]);
  assert.equal(scalar(TEXT, m[0]), 'demo');
  assert.equal(scalar(TEXT, m[1]), '-1.5e3');
  const nested = members(TEXT, m[2]);
  assert.deepEqual(nested.map((x) => [x.key, x.kind, x.line]), [['list', 'array', 6], ['empty', 'object', 7]]);
  const list = members(TEXT, nested[0]);
  assert.deepEqual(list.map((x) => [x.key, x.kind]), [[0, 'number'], [1, 'true'], [2, 'null'], [3, 'object']]);
  assert.equal(scalar(TEXT, members(TEXT, list[3])[0]), 'a"b');
  assert.deepEqual(members(TEXT, nested[1]), []);
  assert.deepEqual(members(TEXT, m[3]).map((x) => scalar(TEXT, x)), ['x', 'y']);
});

test('as JSON again: indented, literals as written, comments and trailing commas gone', () => {
  const top = readJson(TEXT);
  assert.equal(
    pretty(TEXT, top),
    '{\n  "name": "demo",\n  "n": -1.5e3,\n  "nested": {\n    "list": [\n      1,\n      true,\n      null,\n      {\n        "deep": "a\\"b"\n      }\n    ],\n    "empty": {}\n  },\n  "tags": [\n    "x",\n    "y"\n  ]\n}',
  );
  assert.equal(pretty('[12345678901234567890]', readJson('[12345678901234567890]')), '[\n  12345678901234567890\n]');
  assert.equal(pretty(' "s" ', readJson(' "s" ')), '"s"');
});

test("what doesn't read says where", () => {
  const fails = (text: string, re: RegExp, line: number) => {
    try {
      const top = readJson(text);
      members(text, top);
    } catch (e) {
      assert.ok(e instanceof JsonError);
      assert.match(e.message, re);
      assert.equal(e.line, line);
      return;
    }
    assert.fail(`read: ${text}`);
  };
  fails('{\n "a": 1\n', /Unclosed object/, 1);
  fails('[1, 2}', /Unexpected }/, 1);
  fails('{"a": 1}\n{"b": 2}', /after the value/, 2);
  fails('{\n\n "a" 1}', /Expected :/, 3);
  fails('[1 2]', /Expected , or ]/, 1);
  fails('nope', /Unexpected "nope"/, 1);
  fails('', /Unexpected end/, 1);
});

test('paths read as JavaScript', () => {
  assert.equal(pathOf(['compilerOptions', 'paths', '@/*', 0]), '$.compilerOptions.paths["@/*"][0]');
  assert.equal(pathOf([]), '$');
});
