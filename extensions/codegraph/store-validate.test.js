// store-validate.test.js - write validation (kind/confidence enums) and
// friendly corrupt-db errors (MVP-2 Task 7). Run: node --test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import { codeFind } from './find.ts';
import { codeMap } from './map.ts';

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-validate-'));
  store = openStore(join(tmpDir, 'index.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('upsertSymbols rejects an invalid kind', () => {
  assert.throws(
    () =>
      store.upsertSymbols('/a.py', [
        { name: 'm', kind: 'module', line: 1, signature: null },
      ]),
    /invalid kind: module/
  );
  // nothing was written
  assert.deepEqual(store.findSymbols('m', 'exact'), []);
});

test('upsertEdges rejects invalid kind and confidence', () => {
  const base = { caller_file: '/a.py', caller_symbol: null, callee_name: 'x' };
  assert.throws(
    () =>
      store.upsertEdges('/a.py', [
        { ...base, callee_file: null, kind: 'inherits', confidence: 'high' },
      ]),
    /invalid edge kind: inherits/
  );
  assert.throws(
    () =>
      store.upsertEdges('/a.py', [
        { ...base, callee_file: null, kind: 'call', confidence: 'maybe' },
      ]),
    /invalid confidence: maybe/
  );
  assert.equal(store.getAllEdges().length, 0);
});

test('openStore on a garbage file throws the friendly rebuild hint', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-corrupt-'));
  try {
    mkdirSync(join(root, '.codegraph'));
    writeFileSync(join(root, '.codegraph', 'index.sqlite'), 'garbage bytes, not sqlite');
    assert.throws(() => openStore(join(root, '.codegraph', 'index.sqlite')), /索引库损坏/);
    assert.throws(
      () => openStore(join(root, '.codegraph', 'index.sqlite')),
      /删除 .*\.codegraph\/? 后运行 \/reindex/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codeFind and codeMap return the hint text instead of throwing on corrupt db', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-corrupt2-'));
  try {
    mkdirSync(join(root, '.codegraph'));
    writeFileSync(join(root, '.codegraph', 'index.sqlite'), 'garbage bytes, not sqlite');

    assert.match(codeFind(root, 'foo'), /索引库损坏/);
    assert.match(codeMap(root), /索引库损坏/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
