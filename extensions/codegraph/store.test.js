// store.test.js - unit tests for store.ts (SQLite symbol/hash tables)
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

test('upsertFile twice on same path keeps only the latest hash', () => {
  store.upsertFile('/a.py', 'hash-1');
  store.upsertFile('/a.py', 'hash-2');

  assert.deepEqual(store.getFilesChanged([{ path: '/a.py', hash: 'hash-2' }]), []);
  assert.deepEqual(store.getFilesChanged([{ path: '/a.py', hash: 'hash-1' }]), ['/a.py']);
});

test('getFilesChanged returns new and changed paths, omits unchanged ones', () => {
  store.upsertFile('/keep.py', 'hash-keep');
  store.upsertFile('/stale.py', 'hash-old-1');

  const changed = store.getFilesChanged([
    { path: '/keep.py', hash: 'hash-keep' },
    { path: '/stale.py', hash: 'hash-old-2' },
    { path: '/new.py', hash: 'hash-new' },
  ]);

  assert.deepEqual(changed, ['/stale.py', '/new.py']);
});

test('upsertSymbols twice on same file replaces old symbols without duplicates', () => {
  store.upsertSymbols('/m.py', [
    { name: 'foo', kind: 'function', line: 1, signature: 'foo(a)' },
    { name: 'Bar', kind: 'class', line: 5, signature: null },
  ]);
  store.upsertSymbols('/m.py', [
    { name: 'baz', kind: 'method', line: 9, signature: 'baz(self)' },
  ]);

  // old symbols are gone
  assert.deepEqual(store.findSymbols('foo', 'exact'), []);
  assert.deepEqual(store.findSymbols('Bar', 'exact'), []);
  // new symbol present with its file
  assert.deepEqual(store.findSymbols('baz', 'exact'), [
    { name: 'baz', kind: 'method', line: 9, signature: 'baz(self)', file: '/m.py' },
  ]);
  // empty prefix matches every symbol: total count is 1, not 3
  assert.equal(store.findSymbols('', 'prefix').length, 1);
});

test('findSymbols exact/prefix/substring hit the right rows', () => {
  store.upsertSymbols('/calc.py', [
    { name: 'calculate', kind: 'function', line: 10, signature: 'calculate(x)' },
    { name: 'calc', kind: 'function', line: 20, signature: null },
    { name: 'Calculator', kind: 'class', line: 30, signature: null },
    { name: 'calc_total', kind: 'function', line: 40, signature: 'calc_total(x)' },
  ]);
  store.upsertSymbols('/other.py', [
    { name: 'recalculate', kind: 'function', line: 1, signature: 'recalculate(x, y)' },
  ]);

  // exact: only the identical name
  assert.deepEqual(store.findSymbols('calculate', 'exact'), [
    { name: 'calculate', kind: 'function', line: 10, signature: 'calculate(x)', file: '/calc.py' },
  ]);

  // prefix: all /calc.py symbols whose name starts with "calc" (ASCII
  // case-insensitive, like SQLite LIKE). Deterministic order: file, then line.
  assert.deepEqual(
    store.findSymbols('calc', 'prefix').map((r) => r.name),
    ['calculate', 'calc', 'Calculator', 'calc_total']
  );

  // prefix with underscore stays literal (LIKE wildcards are escaped)
  assert.deepEqual(
    store.findSymbols('calc_', 'prefix').map((r) => r.name),
    ['calc_total']
  );

  // substring: also matches /other.py's "recalculate"
  assert.deepEqual(
    store.findSymbols('calc', 'substring').map((r) => r.name),
    ['calculate', 'calc', 'Calculator', 'calc_total', 'recalculate']
  );
});

test('findSymbols filters by kind when given', () => {
  store.upsertSymbols('/calc.py', [
    { name: 'calculate', kind: 'function', line: 10, signature: 'calculate(x)' },
    { name: 'Calculator', kind: 'class', line: 30, signature: null },
  ]);

  assert.deepEqual(store.findSymbols('calc', 'prefix', 'class').map((r) => r.name), ['Calculator']);
  assert.deepEqual(
    store.findSymbols('calc', 'prefix', 'function').map((r) => r.name),
    ['calculate']
  );
  // no kind argument -> everything
  assert.equal(store.findSymbols('calc', 'prefix').length, 2);
});

test('signature column may be null and comes back as null', () => {
  store.upsertSymbols('/s.py', [
    { name: 'calc', kind: 'function', line: 20, signature: null },
  ]);
  const rows = store.findSymbols('calc', 'exact');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signature, null);
});

test('reopening an existing database keeps its data', () => {
  store.upsertFile('/keep.py', 'hash-keep');
  store.upsertSymbols('/keep.py', [
    { name: 'calculate', kind: 'function', line: 10, signature: 'calculate(x)' },
  ]);
  store.close();

  const reopened = openStore(dbPath);
  try {
    assert.deepEqual(reopened.getFilesChanged([{ path: '/keep.py', hash: 'hash-keep' }]), []);
    assert.equal(reopened.findSymbols('calculate', 'exact').length, 1);
  } finally {
    reopened.close();
  }
});

// ---------------------------------------------------------------------------
// edges table (MVP-1): import/call edges between files
// ---------------------------------------------------------------------------
