// find.test.js - tests for find.ts (codeFind: tiered search + LLM-facing text)
// Run: node --test  (Node >= 24 type stripping lets this .js file import
// find.ts directly with the explicit .ts extension)
//
// Fixtures are seeded through a real openStore()-backed SQLite db at
// <tmp>/.codegraph/index.sqlite - the exact layout codeFind reads.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import { codeFind } from './find.ts';

let tmpDir;

// Seed the shared fixture into <tmpDir>/.codegraph/index.sqlite, then close
// the handle: codeFind must open/query/close on its own.
function seedFixture() {
  mkdirSync(join(tmpDir, '.codegraph'), { recursive: true });
  const store = openStore(join(tmpDir, '.codegraph', 'index.sqlite'));
  try {
    store.upsertSymbols('/calc.py', [
      { name: 'calculate', kind: 'function', line: 10, signature: 'calculate(x)' },
      { name: 'calc', kind: 'function', line: 20, signature: null },
      { name: 'Calculator', kind: 'class', line: 30, signature: null },
      { name: 'calc_total', kind: 'function', line: 40, signature: 'calc_total(x)' },
    ]);
    store.upsertSymbols('/other.py', [
      { name: 'recalculate', kind: 'function', line: 1, signature: 'recalculate(x, y)' },
    ]);
    store.upsertSymbols('/nope.py', [
      { name: 'unrelated', kind: 'function', line: 5, signature: 'unrelated()' },
    ]);
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-find-'));
  seedFixture();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('codeFind orders tiers exact > prefix > substring, dedupes, omits null signatures', () => {
  const out = codeFind(tmpDir, 'calc');
  const lines = out.split('\n');
  // exact 'calc' first; then prefix tier in store order (file, line), with the
  // exact row not repeated; then substring-only 'recalculate'.
  // 'calc'/'Calculator' have signature null -> no trailing signature field.
  assert.deepEqual(lines, [
    '/calc.py:20  function  calc',
    '/calc.py:10  function  calculate  calculate(x)',
    '/calc.py:30  class  Calculator',
    '/calc.py:40  function  calc_total  calc_total(x)',
    '/other.py:1  function  recalculate  recalculate(x, y)',
  ]);
  // dedup: the exact row appears exactly once across all tiers
  assert.equal(lines.filter((l) => /  calc$/.test(l)).length, 1);
});

test('codeFind truncates results to top_k (after sorting)', () => {
  const out = codeFind(tmpDir, 'calc', { top_k: 2 });
  assert.deepEqual(out.split('\n'), [
    '/calc.py:20  function  calc',
    '/calc.py:10  function  calculate  calculate(x)',
  ]);
});

test('codeFind default top_k is 20', () => {
  const many = mkdtempSync(join(tmpdir(), 'codegraph-find-many-'));
  try {
    mkdirSync(join(many, '.codegraph'), { recursive: true });
    const store = openStore(join(many, '.codegraph', 'index.sqlite'));
    try {
      const symbols = [];
      for (let i = 1; i <= 25; i++) {
        symbols.push({ name: `calc_${i}`, kind: 'function', line: i, signature: null });
      }
      store.upsertSymbols('/big.py', symbols);
    } finally {
      store.close();
    }

    const lines = codeFind(many, 'calc').split('\n');
    assert.equal(lines.length, 20);
    assert.equal(lines[0], '/big.py:1  function  calc_1');
    assert.equal(lines[19], '/big.py:20  function  calc_20');
    assert.ok(!lines.some((l) => l.includes('calc_21')));
  } finally {
    rmSync(many, { recursive: true, force: true });
  }
});

test('codeFind filters by kind across all tiers', () => {
  assert.deepEqual(codeFind(tmpDir, 'calc', { kind: 'class' }).split('\n'), [
    '/calc.py:30  class  Calculator',
  ]);
  // exact-name hit of the wrong kind is filtered out -> guidance text
  assert.equal(
    codeFind(tmpDir, 'Calculator', { kind: 'function' }),
    '未找到符号 "Calculator"。建议用 rg 做文本搜索。'
  );
});

test('no match returns one-line rg guidance text', () => {
  assert.equal(codeFind(tmpDir, 'zzz'), '未找到符号 "zzz"。建议用 rg 做文本搜索。');
});

test('empty query is invalid and takes the no-results path', () => {
  assert.equal(codeFind(tmpDir, ''), '未找到符号 ""。建议用 rg 做文本搜索。');
});

test('missing index returns reindex hint and does not create the db', () => {
  const empty = mkdtempSync(join(tmpdir(), 'codegraph-find-missing-'));
  try {
    const out = codeFind(empty, 'calc');
    assert.equal(out, `索引不存在,请先运行 /reindex ${empty}`);
    assert.ok(!existsSync(join(empty, '.codegraph', 'index.sqlite')));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('codeFind can be called repeatedly (no leaked db handle)', () => {
  assert.ok(codeFind(tmpDir, 'calc').includes('calculate'));
  assert.ok(codeFind(tmpDir, 'calc').includes('calculate'));
});

test('codeFind orders rows within a tier by file PageRank, tiers still first', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-find-rank-'));
  try {
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      // high-rank hub: named late alphabetically so the old (file, line)
      // order would have placed it last
      store.upsertSymbols('/z_hub.py', [
        { name: 'score_util', kind: 'function', line: 1, signature: 'score_util()' },
      ]);
      store.upsertSymbols('/a_low.py', [
        { name: 'score_low', kind: 'function', line: 1, signature: 'score_low()' },
        // exact-tier hit in the lowest-rank file: tier still beats rank
        { name: 'score', kind: 'function', line: 9, signature: null },
      ]);
      for (const caller of ['/imp1.py', '/imp2.py']) {
        store.upsertSymbols(caller, [
          { name: 'run', kind: 'function', line: 1, signature: null },
        ]);
        store.upsertEdges(caller, [
          {
            caller_file: caller,
            caller_symbol: null,
            callee_name: 'z_hub',
            callee_file: '/z_hub.py',
            kind: 'import',
            confidence: 'high',
          },
        ]);
      }
    } finally {
      store.close();
    }

    const lines = codeFind(root, 'score').split('\n');
    assert.deepEqual(lines, [
      // exact tier first even though /a_low.py has the lowest rank
      '/a_low.py:9  function  score',
      // substring tier: rank puts /z_hub.py before lexicographically-first /a_low.py
      '/z_hub.py:1  function  score_util  score_util()',
      '/a_low.py:1  function  score_low  score_low()',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
