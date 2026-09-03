// edges-samefile.test.js - same-file call edges (MVP-2 Task 6):
// unique-name callees now resolve even inside the caller's own file; direct
// self-recursion still creates no edge. Includes the trace-level scenario
// from the MVP-1 Q1 gap (repomap.py missed its own callers).
// Run: node --test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractEdges } from './edges.ts';
import { traceCallers } from './trace.ts';
import { openStore } from './store.ts';

const SRC = `def b():
    pass

def a():
    b()
    a()  # direct self-recursion: no edge
`;

test('extractEdges: same-file unique callee gets an edge, self-recursion does not', () => {
  const symbolIndex = new Map([
    ['b', { file: 'a.py', count: 1 }],
    ['a', { file: 'a.py', count: 1 }],
  ]);
  const edges = extractEdges(SRC, 'a.py', symbolIndex);
  assert.deepEqual(edges, [
    {
      caller_file: 'a.py',
      caller_symbol: 'a',
      callee_name: 'b',
      callee_file: 'a.py', // same file, still resolved
      kind: 'call',
      confidence: 'low',
    },
  ]);
});

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-samefile-'));
  store = openStore(join(tmpDir, 'index.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// The MVP-1 Q1 scenario: get_ranked_tags was only called from its own file,
// so traceCallers came back empty. Same-file call edges must surface it.
test('traceCallers now finds callers inside the callee own file', () => {
  store.upsertSymbols('repomap.py', [
    { name: 'get_ranked_tags', kind: 'method', line: 648, signature: null },
    { name: 'get_ranked_tags_map', kind: 'method', line: 700, signature: null },
  ]);
  store.upsertEdges('repomap.py', [
    {
      caller_file: 'repomap.py',
      caller_symbol: 'get_ranked_tags_map',
      callee_name: 'get_ranked_tags',
      callee_file: 'repomap.py',
      kind: 'call',
      confidence: 'low',
    },
  ]);
  store.upsertEdges('main.py', [
    {
      caller_file: 'main.py',
      caller_symbol: 'run',
      callee_name: 'get_ranked_tags_map',
      callee_file: 'repomap.py',
      kind: 'call',
      confidence: 'low',
    },
  ]);

  const nodes = traceCallers(store, 'get_ranked_tags', 2);
  assert.ok(
    nodes.some((n) => n.file === 'repomap.py' && n.symbol === 'get_ranked_tags_map'),
    'same-file caller missing'
  );
  assert.ok(
    nodes.some((n) => n.file === 'main.py' && n.symbol === 'run'),
    'transitive outer caller missing'
  );
});

test('extractEdges: cross-file behavior unchanged (still resolved)', () => {
  const symbolIndex = new Map([
    ['helper', { file: 'lib.py', count: 1 }],
  ]);
  const src = 'def work():\n    helper()\n';
  const edges = extractEdges(src, 'app.py', symbolIndex);
  assert.deepEqual(edges, [
    {
      caller_file: 'app.py',
      caller_symbol: 'work',
      callee_name: 'helper',
      callee_file: 'lib.py',
      kind: 'call',
      confidence: 'low',
    },
  ]);
});
