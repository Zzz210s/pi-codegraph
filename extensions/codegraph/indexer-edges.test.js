// indexer-edges.test.js - indexRepo integration tests for import/call edge
// persistence (storage shape and replacement semantics).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexRepo } from './indexer.ts';
import { openStore } from './store.ts';

test('indexRepo: stores import and call edges, ambiguous/unknown calls get none', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-edges-'));
  try {
    mkdirSync(join(root, 'pkg_b'));
    mkdirSync(join(root, 'pkg_c'));
    writeFileSync(
      join(root, 'a.py'),
      [
        'import os',
        'from pkg_b.helper import unique_target',
        '',
        'def work():',
        '    unique_target()',
        '    dup()',
        '    external_call()',
        '',
      ].join('\n')
    );
    writeFileSync(join(root, 'pkg_b', 'helper.py'), 'def unique_target():\n    return 1\n');
    writeFileSync(join(root, 'pkg_c', 'one.py'), 'def dup():\n    pass\n');
    writeFileSync(join(root, 'pkg_c', 'two.py'), 'def dup():\n    pass\n');

    const r = indexRepo(root);
    assert.equal(r.files, 4);
    assert.equal(r.symbols, 4, 'work + unique_target + dup + dup');

    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      // rows ordered by callee_name: os < pkg_b.helper < unique_target
      assert.deepEqual(store.getEdgesFrom(['a.py']), [
        { caller_file: 'a.py', caller_symbol: null, callee_name: 'os', callee_file: null, kind: 'import', confidence: 'high' },
        { caller_file: 'a.py', caller_symbol: null, callee_name: 'pkg_b.helper', callee_file: 'pkg_b/helper.py', kind: 'import', confidence: 'high' },
        { caller_file: 'a.py', caller_symbol: 'work', callee_name: 'unique_target', callee_file: 'pkg_b/helper.py', kind: 'call', confidence: 'low' },
      ]);
      assert.deepEqual(store.getEdgesFrom(['pkg_b/helper.py']), [], 'no edges for edgeless files');
      assert.deepEqual(store.getEdgesToName('dup'), [], 'ambiguous name (2 defs) -> no call edge');
      assert.equal(store.getEdgesToFile('pkg_b/helper.py').length, 2, 'one import + one call edge point at helper.py');
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexRepo: edges persist across unchanged runs and are replaced when the file changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-edges2-'));
  try {
    writeFileSync(
      join(root, 'a.py'),
      'import os\n\ndef work():\n    helper()\n'
    );
    writeFileSync(join(root, 'helper.py'), 'def helper():\n    return 1\n');

    indexRepo(root);

    // nothing changed: no re-parse, edges stay queryable
    const r2 = indexRepo(root);
    assert.equal(r2.files, 0);
    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      assert.equal(store.getEdgesFrom(['a.py']).length, 2, 'import + call edge survive a no-op run');

      // file rewritten without any imports/calls: its old edges are gone
      writeFileSync(join(root, 'a.py'), 'def work():\n    return 2\n');
      const r3 = indexRepo(root);
      assert.equal(r3.files, 1);
      assert.deepEqual(store.getEdgesFrom(['a.py']), []);
      assert.equal(store.getEdgesFrom(['helper.py']).length, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
