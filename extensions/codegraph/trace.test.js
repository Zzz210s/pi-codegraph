// trace.test.js - traceCallers/traceCallees unit tests (call graph traversal)
// Run: node --test  (Node >= 24: native TS type stripping lets this .js file
// import graph.ts directly with the explicit .ts extension)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import { traceCallers, traceCallees } from './trace.ts';

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

test('traceCallers finds direct and transitive callers at increasing depth', () => {
  buildBase(store);

  assert.deepEqual(traceCallers(store, 'c'), [
    { file: '/b.py', symbol: 'b', via: 'call', depth: 1 },
    { file: '/a.py', symbol: 'a', via: 'call', depth: 2 },
  ]);
});

test('traceCallers climbs import edges to the importing file, then to the callers of its symbols', () => {
  buildBase(store);
  // x calls a, so tracing callers of imported module d climbs into /a.py via
  // the import edge (symbol null) and then finds x through a.
  store.upsertSymbols('/x.py', [symbol('x', '/x.py')]);
  store.upsertEdges('/x.py', [call('/x.py', 'x', 'a', '/a.py')]);

  assert.deepEqual(traceCallers(store, 'd'), [
    { file: '/a.py', symbol: null, via: 'import', depth: 1 },
    { file: '/x.py', symbol: 'x', via: 'call', depth: 2 },
  ]);
});

test('traceCallers import climb treats every symbol of the importing file as a candidate caller', () => {
  buildBase(store); // /a.py defines a and imports d
  // /a.py also defines 'helper', which makes no calls at all; /y.py calls it.
  // Only the all-symbols climb (plan binding) can surface y as a caller of d.
  store.upsertSymbols('/a.py', [symbol('a', '/a.py'), symbol('helper', '/a.py')]);
  store.upsertSymbols('/y.py', [symbol('y', '/y.py')]);
  store.upsertEdges('/y.py', [call('/y.py', 'y', 'helper', '/a.py')]);

  assert.deepEqual(traceCallers(store, 'd'), [
    { file: '/a.py', symbol: null, via: 'import', depth: 1 },
    { file: '/y.py', symbol: 'y', via: 'call', depth: 2 },
  ]);
});

test('traceCallers returns [] for unknown names; depth 0/negative yield only the seed node', () => {
  buildBase(store);
  assert.deepEqual(traceCallers(store, 'zzz'), []);
  assert.deepEqual(traceCallers(store, 'zzz', 0), []);
  const seed = { file: '/c.py', symbol: 'c', via: 'call', depth: 0 };
  assert.deepEqual(traceCallers(store, 'c', 0), [seed]);
  assert.deepEqual(traceCallers(store, 'c', -5), [seed]); // negative == depth 0
});

// --- traceCallees ---

test('traceCallees walks the call chain downward, ignoring import edges', () => {
  buildBase(store);

  assert.deepEqual(traceCallees(store, 'a'), [
    { file: '/b.py', symbol: 'b', via: 'call', depth: 1 },
    { file: '/c.py', symbol: 'c', via: 'call', depth: 2 },
  ]);

  // module d is reachable only via an import edge, so it is never a callee
  assert.deepEqual(traceCallees(store, 'a', 99).map((n) => n.symbol), ['b', 'c']);

  // a leaf and an unknown symbol have no callees
  assert.deepEqual(traceCallees(store, 'c'), []);
  assert.deepEqual(traceCallees(store, 'zzz'), []);

  // depth 0 / negative: seed node only, uniform with traceCallers
  assert.deepEqual(traceCallees(store, 'a', 0), [{ file: '/a.py', symbol: 'a', via: 'call', depth: 0 }]);
  assert.deepEqual(traceCallees(store, 'a', -2), [{ file: '/a.py', symbol: 'a', via: 'call', depth: 0 }]);
});

test('traceCallees does not descend ambiguous callees (callee_file null, multiple defs)', () => {
  store.upsertSymbols('/a.py', [symbol('a', '/a.py')]);
  store.upsertSymbols('/u1.py', [symbol('util', '/u1.py')]);
  store.upsertSymbols('/u2.py', [symbol('util', '/u2.py')]);
  store.upsertEdges('/a.py', [call('/a.py', 'a', 'util', null)]);

  // the indexer declined to resolve 'util' (ambiguous), so even though defs
  // exist the traversal must not follow the alphabetically-first one
  assert.deepEqual(traceCallees(store, 'a'), []);
});

test('traceCallees falls back to the unique definition when callee_file is null', () => {
  store.upsertSymbols('/a.py', [symbol('a', '/a.py')]);
  store.upsertSymbols('/b.py', [symbol('b', '/b.py')]);
  store.upsertSymbols('/c.py', [symbol('c', '/c.py')]);
  store.upsertEdges('/a.py', [call('/a.py', 'a', 'b', null)]);
  store.upsertEdges('/b.py', [call('/b.py', 'b', 'c', '/c.py')]);

  assert.deepEqual(traceCallees(store, 'a'), [
    { file: '/b.py', symbol: 'b', via: 'call', depth: 1 },
    { file: '/c.py', symbol: 'c', via: 'call', depth: 2 },
  ]);
});

// --- cycles and depth clamp ---

test('a<->b call cycle terminates: visited set breaks the loop', () => {
  store.upsertSymbols('/m.py', [symbol('m', '/m.py')]);
  store.upsertSymbols('/n.py', [symbol('n', '/n.py')]);
  store.upsertEdges('/m.py', [call('/m.py', 'm', 'n', '/n.py')]);
  store.upsertEdges('/n.py', [call('/n.py', 'n', 'm', '/m.py')]);

  const callers = traceCallers(store, 'm', 99);
  assert.deepEqual(callers, [
    { file: '/n.py', symbol: 'n', via: 'call', depth: 1 },
    { file: '/m.py', symbol: 'm', via: 'call', depth: 2 },
  ]);
  assert.ok(callers.every((n) => n.depth <= 5));

  const callees = traceCallees(store, 'm', 99);
  assert.deepEqual(callees, [{ file: '/n.py', symbol: 'n', via: 'call', depth: 1 }]);
});

test('depth is clamped to 5 (depth=99 behaves like depth=5)', () => {
  const files = ['/f1.py', '/f2.py', '/f3.py', '/f4.py', '/f5.py', '/f6.py', '/f7.py'];
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  for (let i = 0; i < files.length; i++) {
    store.upsertSymbols(files[i], [symbol(names[i], files[i])]);
  }
  for (let i = 0; i < files.length - 1; i++) {
    store.upsertEdges(files[i], [call(files[i], names[i], names[i + 1], files[i + 1])]);
  }

  // a -> b -> c -> d -> e -> f -> g : 99 clamps to 5 hops (f at depth 5)
  const callees = traceCallees(store, 'a', 99);
  assert.deepEqual(callees.map((n) => n.symbol), ['b', 'c', 'd', 'e', 'f']);
  assert.equal(Math.max(...callees.map((n) => n.depth)), 5);
  assert.equal(callees.length, 5);

  const callers = traceCallers(store, 'g', 99);
  assert.deepEqual(callers.map((n) => n.symbol), ['f', 'e', 'd', 'c', 'b']);
  assert.equal(Math.max(...callers.map((n) => n.depth)), 5);
});

// --- blastRadius ---
