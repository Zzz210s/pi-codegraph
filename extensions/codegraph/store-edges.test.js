// store-edges.test.js - store.ts edge table tests (upsert/query/replace)
// Run: node --test  (Node >= 24: native TS type stripping lets this .js file
// import store.ts directly with the explicit .ts extension)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import Database from 'better-sqlite3';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-store-'));
  dbPath = join(tmpDir, 'index.db');
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const byCallee = (a, b) => a.callee_name.localeCompare(b.callee_name);
const byCaller = (a, b) => a.caller_file.localeCompare(b.caller_file);

test('upsertEdges roundtrips through getEdgesFrom/getEdgesToName/getEdgesToFile', () => {
  const importExternal = {
    caller_file: '/a.py',
    caller_symbol: null,
    callee_name: 'os.path',
    callee_file: null,
    kind: 'import',
    confidence: 'high',
  };
  const importLocal = {
    caller_file: '/a.py',
    caller_symbol: null,
    callee_name: 'util.helper',
    callee_file: '/util.py',
    kind: 'import',
    confidence: 'high',
  };
  const callA = {
    caller_file: '/a.py',
    caller_symbol: 'run',
    callee_name: 'helper',
    callee_file: '/util.py',
    kind: 'call',
    confidence: 'low',
  };
  const callB = {
    caller_file: '/b.py',
    caller_symbol: 'main',
    callee_name: 'helper',
    callee_file: '/util.py',
    kind: 'call',
    confidence: 'low',
  };

  store.upsertEdges('/a.py', [importExternal, importLocal, callA]);
  store.upsertEdges('/b.py', [callB]);

  // caller-side lookup: exactly the edges of the given caller files
  assert.deepEqual(
    [...store.getEdgesFrom(['/a.py'])].sort(byCallee),
    [importExternal, importLocal, callA].sort(byCallee)
  );
  assert.equal(store.getEdgesFrom(['/a.py', '/b.py']).length, 4);
  assert.deepEqual(store.getEdgesFrom([]), []);

  // callee_name lookup: exact match only, no prefix/substring
  assert.deepEqual(
    [...store.getEdgesToName('helper')].sort(byCaller),
    [callA, callB].sort(byCaller)
  );
  assert.deepEqual(store.getEdgesToName('help'), []);
  assert.deepEqual(store.getEdgesToName('util.helper'), [importLocal]);

  // callee_file lookup: exact match, all kinds
  assert.equal(store.getEdgesToFile('/util.py').length, 3);
  assert.deepEqual(store.getEdgesToFile('/nope.py'), []);

  // null fields survive the roundtrip
  const ext = store.getEdgesToName('os.path');
  assert.equal(ext.length, 1);
  assert.equal(ext[0].callee_file, null);
  assert.equal(ext[0].caller_symbol, null);
});

test('getEdgesFromFile returns only the edges of that caller file', () => {
  const edgeA = {
    caller_file: '/a.py',
    caller_symbol: 'run',
    callee_name: 'helper',
    callee_file: '/util.py',
    kind: 'call',
    confidence: 'low',
  };
  const edgeB = {
    caller_file: '/b.py',
    caller_symbol: 'main',
    callee_name: 'helper',
    callee_file: '/util.py',
    kind: 'call',
    confidence: 'low',
  };
  store.upsertEdges('/a.py', [edgeA]);
  store.upsertEdges('/b.py', [edgeB]);

  assert.deepEqual(store.getEdgesFromFile('/a.py'), [edgeA]);
  assert.deepEqual(store.getEdgesFromFile('/b.py'), [edgeB]);
  assert.deepEqual(store.getEdgesFromFile('/nope.py'), []);
});

test('upsertEdges twice on same caller file replaces old edges without duplicates', () => {
  store.upsertEdges('/a.py', [
    {
      caller_file: '/a.py',
      caller_symbol: null,
      callee_name: 'os',
      callee_file: null,
      kind: 'import',
      confidence: 'high',
    },
    {
      caller_file: '/a.py',
      caller_symbol: 'run',
      callee_name: 'helper',
      callee_file: '/util.py',
      kind: 'call',
      confidence: 'low',
    },
  ]);

  const replacement = [
    {
      caller_file: '/a.py',
      caller_symbol: 'main',
      callee_name: 'other',
      callee_file: '/o.py',
      kind: 'call',
      confidence: 'low',
    },
  ];
  store.upsertEdges('/a.py', replacement);

  // only the newest edge remains for that caller file
  assert.deepEqual(store.getEdgesFrom(['/a.py']), replacement);
  // stale edges no longer show up in callee-side lookups
  assert.deepEqual(store.getEdgesToName('os'), []);
  assert.deepEqual(store.getEdgesToName('helper'), []);
  assert.deepEqual(store.getEdgesToName('other'), replacement);
  assert.equal(store.getEdgesToFile('/util.py').length, 0);
});

test('findSymbols throws on invalid mode instead of falling back to substring', () => {
  store.upsertSymbols('/calc.py', [
    { name: 'calculate', kind: 'function', line: 10, signature: null },
  ]);

  assert.throws(() => store.findSymbols('calc', 'bogus'), /^Error: invalid mode: bogus$/);
  // mode is not normalized: uppercase is invalid too
  assert.throws(() => store.findSymbols('calc', 'EXACT'), /^Error: invalid mode: EXACT$/);

  // valid modes still work
  assert.equal(store.findSymbols('calculate', 'exact').length, 1);
  assert.equal(store.findSymbols('calc', 'prefix').length, 1);
  assert.equal(store.findSymbols('calc', 'substring').length, 1);
});
