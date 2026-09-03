// pagerank.test.js - unit tests for pagerank.ts (PageRank + file-level graph)
// Run: node --test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import { pageRank, getFileRanks } from './pagerank.ts';

// ---------------------------------------------------------------------------
// pageRank pure algorithm
// ---------------------------------------------------------------------------

test('cycle nodes rank equal and above an isolated node; scores sum to 1', () => {
  const links = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a' },
  ];
  const rank = pageRank(['a', 'b', 'c', 'd'], links);

  assert.equal(rank.size, 4);
  assert.ok(Math.abs(rank.get('a') - rank.get('b')) < 1e-9);
  assert.ok(Math.abs(rank.get('b') - rank.get('c')) < 1e-9);
  assert.ok(rank.get('a') > rank.get('d'));
  const sum = [...rank.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('dangling node (no out-edges) still receives rank, sum stays 1', () => {
  const links = [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
  ];
  const rank = pageRank(['a', 'b', 'c'], links);

  // b and c are dangling (no out edges) but must keep nonzero rank
  assert.ok(rank.get('b') > 0);
  assert.ok(rank.get('c') > 0);
  assert.ok(Math.abs(rank.get('b') - rank.get('c')) < 1e-9);
  const sum = [...rank.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('hub file pointed at by many links ranks highest', () => {
  // a, b, c all link to hub; hub links back to a only.
  const links = [
    { from: 'a', to: 'hub' },
    { from: 'b', to: 'hub' },
    { from: 'c', to: 'hub' },
    { from: 'hub', to: 'a' },
  ];
  const rank = pageRank(['a', 'b', 'c', 'hub'], links);

  assert.ok(rank.get('hub') > rank.get('a'));
  assert.ok(rank.get('hub') > rank.get('b'));
  assert.ok(rank.get('hub') > rank.get('c'));
});

test('out-link weight matters when one node fans out unevenly', () => {
  // src sends 2 links to hub and 1 to other; peer sends 1 to each.
  // With parallel-link weighting hub must beat other.
  const rank = pageRank(
    ['src', 'peer', 'hub', 'other'],
    [
      { from: 'src', to: 'hub' },
      { from: 'src', to: 'hub' },
      { from: 'src', to: 'other' },
      { from: 'peer', to: 'hub' },
      { from: 'peer', to: 'other' },
    ]
  );
  assert.ok(rank.get('hub') > rank.get('other'));
});

test('empty graph returns empty map without throwing', () => {
  assert.equal(pageRank([], []).size, 0);
});

// ---------------------------------------------------------------------------
// getFileRanks over a real store
// ---------------------------------------------------------------------------

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-pagerank-'));
  store = openStore(join(tmpDir, 'index.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedStarStore() {
  // hub.py defines util (unique); a/b/c import hub.py and call util.
  store.upsertSymbols('hub.py', [
    { name: 'util', kind: 'function', line: 1, signature: 'def util(): ...' },
  ]);
  for (const f of ['a.py', 'b.py', 'c.py']) {
    store.upsertSymbols(f, [
      { name: `work_${f[0]}`, kind: 'function', line: 2, signature: null },
    ]);
    store.upsertEdges(f, [
      {
        caller_file: f,
        caller_symbol: null,
        callee_name: 'hub.py',
        callee_file: 'hub.py',
        kind: 'import',
        confidence: 'high',
      },
      {
        caller_file: f,
        caller_symbol: `work_${f[0]}`,
        callee_name: 'util',
        callee_file: 'hub.py',
        kind: 'call',
        confidence: 'low',
      },
    ]);
  }
  store.upsertSymbols('isolated.py', [
    { name: 'lone', kind: 'function', line: 3, signature: null },
  ]);
  // hub calls back into a.py so a.py has an in-edge (strictly above isolated)
  store.upsertEdges('hub.py', [
    {
      caller_file: 'hub.py',
      caller_symbol: 'util',
      callee_name: 'work_a',
      callee_file: 'a.py',
      kind: 'call',
      confidence: 'low',
    },
  ]);
}

test('getFileRanks ranks the import hub above callers and isolated file', () => {
  seedStarStore();
  const ranks = getFileRanks(store);

  // every file that has symbols or edges appears
  for (const f of ['hub.py', 'a.py', 'b.py', 'c.py', 'isolated.py']) {
    assert.ok(ranks.has(f), `${f} missing from ranks`);
  }
  assert.ok(ranks.get('hub.py') > ranks.get('a.py'));
  assert.ok(ranks.get('hub.py') > ranks.get('isolated.py'));
  assert.ok(ranks.get('a.py') > ranks.get('isolated.py'));
});

test('getFileRanks skips edges with unresolved callee_file (external imports)', () => {
  seedStarStore();
  store.upsertEdges('a.py', [
    {
      caller_file: 'a.py',
      caller_symbol: null,
      callee_name: 'requests',
      callee_file: null,
      kind: 'import',
      confidence: 'high',
    },
  ]);
  const ranks = getFileRanks(store);
  assert.ok(ranks.has('a.py'));
  assert.equal(ranks.has('requests'), false);
});

// ---------------------------------------------------------------------------
// store.getAllEdges (added for pagerank; exercised through getFileRanks too)
// ---------------------------------------------------------------------------

test('getAllEdges returns every stored edge ordered by caller file', () => {
  seedStarStore();
  const edges = store.getAllEdges();
  // 3 files x (1 import + 1 call) + 1 hub.py call-back = 7
  assert.equal(edges.length, 7);
  assert.deepEqual(
    edges.map((e) => e.caller_file),
    ['a.py', 'a.py', 'b.py', 'b.py', 'c.py', 'c.py', 'hub.py']
  );
});
