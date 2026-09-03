// blast.test.js - blastRadius unit tests (bidirectional reachability)
// Run: node --test  (Node >= 24: native TS type stripping lets this .js file
// import graph.ts directly with the explicit .ts extension)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import { blastRadius } from './blast.ts';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-graph-'));
  dbPath = join(tmpDir, 'index.db');
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- helpers to hand-build a small graph ---

const symbol = (name, file) => ({ name, kind: 'function', line: 1, signature: `${name}()` });
const call = (callerFile, callerSymbol, calleeName, calleeFile) => ({
  caller_file: callerFile,
  caller_symbol: callerSymbol,
  callee_name: calleeName,
  callee_file: calleeFile,
  kind: 'call',
  confidence: 'low',
});
const imp = (callerFile, ref, calleeFile) => ({
  caller_file: callerFile,
  caller_symbol: null,
  callee_name: ref,
  callee_file: calleeFile,
  kind: 'import',
  confidence: 'high',
});

// Base graph: a calls b, b calls c; a imports module d.
//   /a.py  a -> b (call), a -> d (import)
//   /b.py  b -> c (call)
//   /c.py  defines c (leaf)
//   /d.py  defines d (imported module)
function buildBase(store) {
  for (const file of ['/a.py', '/b.py', '/c.py', '/d.py']) {
    store.upsertSymbols(file, [symbol(file.slice(1, 2), file)]);
  }
  store.upsertEdges('/a.py', [call('/a.py', 'a', 'b', '/b.py'), imp('/a.py', 'd', '/d.py')]);
  store.upsertEdges('/b.py', [call('/b.py', 'b', 'c', '/c.py')]);
}

// --- traceCallers ---

test('blastRadius gathers files, symbols and tests in both directions', () => {
  buildBase(store);
  store.upsertSymbols('/tests/test_x.py', [symbol('test_x', '/tests/test_x.py')]);
  store.upsertEdges('/tests/test_x.py', [call('/tests/test_x.py', 'test_x', 'b', '/b.py')]);

  const blast = blastRadius(store, { file: '/b.py', symbol: 'b' });

  // callers (/a.py, /tests/test_x.py) + callees (/c.py) + import target (/d.py)
  assert.deepEqual(blast.files, [
    '/a.py',
    '/b.py',
    '/c.py',
    '/d.py',
    '/tests/test_x.py',
  ]);
  assert.deepEqual(blast.symbols, ['a', 'b', 'c', 'test_x']);
  assert.deepEqual(blast.tests, ['/tests/test_x.py']);
});

test('blastRadius from a file alone reaches callees, callers and imports', () => {
  buildBase(store);

  const blast = blastRadius(store, { file: '/a.py' });
  assert.deepEqual(blast.files, ['/a.py', '/b.py', '/c.py', '/d.py']);
  assert.deepEqual(blast.symbols, ['a', 'b', 'c']);
  assert.deepEqual(blast.tests, []);

  // depth 0 / negative: seed file only, uniform with the other two functions
  const seedOnly = { files: ['/a.py'], symbols: [], tests: [] };
  assert.deepEqual(blastRadius(store, { file: '/a.py' }, 0), seedOnly);
  assert.deepEqual(blastRadius(store, { file: '/a.py' }, -7), seedOnly);
});

test('blastRadius from a symbol alone resolves its definition file', () => {
  buildBase(store);

  const blast = blastRadius(store, { symbol: 'c' });
  assert.deepEqual(blast.files, ['/a.py', '/b.py', '/c.py']);
});
