// indexer-multi.test.js - indexRepo over a mixed-language repo (.py/.ts/
// .tsx/.go/.java) including vendor/target skip dirs and a TS import resolved
// to a repo file. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexRepo } from './indexer.ts';
import { openStore } from './store.ts';

test('indexRepo: mixed languages, skip dirs, TS import resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-multi-'));
  try {
    writeFileSync(join(root, 'a.py'), 'def py_fn():\n    pass\n');
    writeFileSync(join(root, 'util.ts'), 'export function u(): number {\n  return 1;\n}\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { u } from './util';\n\nexport function tsMain(): void {\n  u();\n}\n"
    );
    writeFileSync(join(root, 'c.go'), 'package c\n\nfunc GoFn() int {\n\treturn 1\n}\n');
    writeFileSync(join(root, 'd.java'), 'class D {\n  void j() {}\n}\n');

    mkdirSync(join(root, 'vendor'));
    writeFileSync(join(root, 'vendor', 'skip.ts'), 'export function vendored(): void {}\n');
    mkdirSync(join(root, 'target'));
    writeFileSync(join(root, 'target', 'Skip.java'), 'class Skip {}\n');

    const r = indexRepo(root);
    assert.equal(r.files, 5, 'py + 2 ts + go + java; vendor/target skipped');
    assert.equal(r.symbols, 6, 'py_fn, u, tsMain, GoFn, D.j -> 5... plus D class = 6');

    const store = openStore(join(root, '.codegraph', 'index.sqlite'));
    try {
      assert.deepEqual(store.findSymbols('py_fn', 'exact').map((s) => s.file), ['a.py']);
      assert.deepEqual(store.findSymbols('tsMain', 'exact').map((s) => s.file), ['b.ts']);
      assert.deepEqual(store.findSymbols('GoFn', 'exact').map((s) => s.file), ['c.go']);
      assert.deepEqual(store.findSymbols('j', 'exact').map((s) => s.file), ['d.java']);

      // vendor/target never indexed
      assert.deepEqual(store.findSymbols('vendored', 'substring'), []);
      assert.deepEqual(store.findSymbols('Skip', 'substring'), []);

      // TS relative import resolves to the repo file util.ts
      const bEdges = store.getEdgesFrom(['b.ts']);
      assert.ok(
        bEdges.some(
          (e) =>
            e.kind === 'import' &&
            e.callee_name === './util' &&
            e.callee_file === 'util.ts'
        ),
        `import edge to util.ts missing: ${JSON.stringify(bEdges)}`
      );
      // and the unique-name call u() resolves to util.ts
      assert.ok(
        bEdges.some(
          (e) => e.kind === 'call' && e.callee_name === 'u' && e.callee_file === 'util.ts'
        )
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexRepo: second run over mixed repo is a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-multi2-'));
  try {
    writeFileSync(join(root, 'm.py'), 'def one(): pass\n');
    writeFileSync(join(root, 'n.ts'), 'export function two(): void {}\n');
    indexRepo(root);
    const r2 = indexRepo(root);
    assert.equal(r2.files, 0);
    assert.equal(r2.symbols, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
