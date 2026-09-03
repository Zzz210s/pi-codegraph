// indexer.test.js - indexRepo integration tests (incremental repo indexing
// through store.ts: symbols, skipping, races).
// extractSymbols / extractEdges unit tests live in symbols.test.js / edges.test.js;
// edge integration tests live in indexer-edges.test.js.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexRepo } from './indexer.ts';
import { openStore } from './store.ts';
import { FIXTURE } from './fixtures.js';

test('indexRepo: first run indexes .py files, skips ignored dirs, stores relative paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-index-'));
  try {
    mkdirSync(join(root, 'pkg'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, '__pycache__'));
    writeFileSync(join(root, 'app.py'), FIXTURE);
    writeFileSync(join(root, 'pkg', 'nested.py'), 'def helper():\n    return 1\n');
    writeFileSync(join(root, 'node_modules', 'skip1.py'), 'def skipped1(): pass\n');
    writeFileSync(join(root, '.git', 'skip2.py'), 'def skipped2(): pass\n');
    writeFileSync(join(root, '__pycache__', 'skip3.py'), 'def skipped3(): pass\n');

    const r = indexRepo(root);

    assert.equal(r.files, 2, 'two non-ignored .py files parsed');
    assert.equal(r.symbols, 5, '4 from app.py + 1 from pkg/nested.py');
    assert.equal(typeof r.ms, 'number');
    assert.ok(r.ms >= 0);
    assert.ok(existsSync(join(root, '.codegraph', 'index.sqlite')), 'db created at <root>/.codegraph/index.sqlite');

    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      assert.deepEqual(store.findSymbols('Config', 'exact').map((s) => s.file), ['app.py']);
      assert.deepEqual(store.findSymbols('helper', 'exact').map((s) => s.file), ['pkg/nested.py']);
      assert.deepEqual(store.findSymbols('skipped', 'substring'), [], 'ignored dirs not indexed');
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexRepo: unchanged files are skipped, modified file re-parsed with symbols replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-index-'));
  try {
    writeFileSync(join(root, 'app.py'), FIXTURE);
    writeFileSync(join(root, 'pkg-helper.py'), 'def helper():\n    return 1\n');

    const r1 = indexRepo(root);
    assert.equal(r1.files, 2);
    assert.equal(r1.symbols, 5);

    // nothing changed -> no re-parse, db content stable
    const r2 = indexRepo(root);
    assert.equal(r2.files, 0);
    assert.equal(r2.symbols, 5);

    // modify one file: only it is re-parsed, its old symbol is replaced
    writeFileSync(join(root, 'pkg-helper.py'), 'def renamed():\n    return 2\n');
    const r3 = indexRepo(root);
    assert.equal(r3.files, 1);
    assert.equal(r3.symbols, 5);

    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      assert.deepEqual(store.findSymbols('helper', 'exact'), []);
      assert.deepEqual(store.findSymbols('renamed', 'exact').map((s) => s.file), ['pkg-helper.py']);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexRepo: changed file reduced to zero symbols still records hash and clears rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-index-'));
  try {
    writeFileSync(join(root, 'app.py'), FIXTURE);
    writeFileSync(join(root, 'shrinking.py'), 'def only(): pass\n');

    const r1 = indexRepo(root);
    assert.equal(r1.files, 2);
    assert.equal(r1.symbols, 5);

    writeFileSync(join(root, 'shrinking.py'), 'import os\n'); // no symbols left
    const r2 = indexRepo(root);
    assert.equal(r2.files, 1, 'hash changed so file is re-parsed');
    assert.equal(r2.symbols, 4, 'old symbol removed, nothing added');

    // hash was recorded even for the zero-symbol file: next run is a no-op
    const r3 = indexRepo(root);
    assert.equal(r3.files, 0);

    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      assert.deepEqual(store.findSymbols('only', 'exact'), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexRepo: file vanishing between scan and read is skipped without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-vanish-'));
  try {
    writeFileSync(join(root, 'a.py'), 'def a(): pass\n');
    writeFileSync(join(root, 'ghost.py'), 'def ghost(): pass\n');

    // Simulate the scan->read race: ghost.py exists during the directory scan
    // but is gone (or unreadable) when its content is read.
    const r = indexRepo(root, {
      readFile: (abs) => {
        if (abs.endsWith('ghost.py')) {
          const err = new Error("ENOENT: no such file or directory, open 'ghost.py'");
          err.code = 'ENOENT';
          throw err;
        }
        return readFileSync(abs, 'utf8');
      },
    });

    assert.equal(r.files, 1, 'only the readable file was indexed');
    assert.equal(r.symbols, 1);

    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      assert.deepEqual(store.findSymbols('ghost', 'exact'), [], 'vanished file left no symbols');
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
