// map.test.js - unit tests for map.ts (code_map: PageRank-ordered repo map
// with a token budget). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codeMap } from './map.ts';
import { indexRepo } from './indexer.ts';

// Fixture repo shape:
//   hub.py    many symbols; imported and called by a.py and b.py (top rank)
//   a.py      work_a() calls hub.util()
//   b.py      work_b() calls hub.util()
//   isolated.py  lone symbol, no edges (lowest rank)
function makeRepo(withBigHub = true) {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-map-'));
  const hubDefs = withBigHub
    ? Array.from({ length: 40 }, (_, i) => `def hub_fn_${i}(x):\n    return ${i}\n`).join('\n')
    : 'def util():\n    return 1\n';
  writeFileSync(join(root, 'hub.py'), hubDefs);
  writeFileSync(join(root, 'a.py'), 'import hub\n\ndef work_a():\n    return hub.util()\n');
  writeFileSync(join(root, 'b.py'), 'import hub\n\ndef work_b():\n    return hub.util()\n');
  writeFileSync(join(root, 'isolated.py'), 'def lone():\n    pass\n');
  indexRepo(root);
  return root;
}

test('codeMap: hub file ranks first, header reports counts and budget', () => {
  const root = makeRepo(false); // small hub: everything fits
  try {
    const out = codeMap(root, { token_budget: 8000 });
    const lines = out.split('\n');

    assert.match(lines[0], /^仓库地图: 4 文件 \/ 4 符号 \/ \d+ tokens\(预算 8000\)$/);
    // rank order: hub.py before a.py / b.py / isolated.py
    const pos = (name) => lines.indexOf(name);
    assert.ok(pos('hub.py') !== -1);
    assert.ok(pos('hub.py') < pos('a.py'));
    assert.ok(pos('a.py') < pos('isolated.py'));
    // symbol lines are indented under their file header
    assert.ok(lines.includes('  1  function  util  def util():'));
    // nothing truncated
    assert.ok(!out.includes('预算截断'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codeMap: tight budget truncates with marker, low-rank files dropped', () => {
  const root = makeRepo(true); // 40-symbol hub exceeds the 200 floor budget
  try {
    const out = codeMap(root, { token_budget: 200 });
    assert.ok(out.includes('... 预算截断'), 'truncation marker expected');
    assert.ok(!out.includes('isolated.py'), 'lowest-rank file must be cut first');
    assert.ok(out.includes('hub.py'), 'top-rank file is included');
    const header = out.split('\n')[0];
    assert.match(header, /预算 200\)$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codeMap: budget clamped to 200..8000', () => {
  const root = makeRepo(false);
  try {
    assert.match(codeMap(root, { token_budget: 5 }).split('\n')[0], /预算 200\)$/);
    assert.match(codeMap(root, { token_budget: 999999 }).split('\n')[0], /预算 8000\)$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codeMap: missing db asks for /reindex; empty index says so', () => {
  const empty = mkdtempSync(join(tmpdir(), 'codegraph-map-'));
  try {
    assert.match(codeMap(empty), /索引不存在,请先运行 \/reindex/);
    indexRepo(empty); // db created, zero symbols
    assert.match(codeMap(empty), /索引为空/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
