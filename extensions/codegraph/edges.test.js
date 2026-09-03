// edges.test.js - extractEdges unit tests (import/call edge extraction).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEdges } from './edges.ts';

test('extractEdges: import edges resolve repo modules, externals get null, duplicates deduped', () => {
  const src = [
    'import os',
    'import pkg.mod',
    'import pkg.mod as m', // duplicate of pkg.mod: deduped
    'from pkg.mod import X', // duplicate of pkg.mod: deduped
    'from external.lib import thing',
    'import json, pkg.other',
  ].join('\n');

  const edges = extractEdges(
    src,
    'a.py',
    new Map(),
    new Set(['a.py', 'pkg/mod.py', 'pkg/other.py'])
  );

  assert.deepEqual(edges, [
    { caller_file: 'a.py', caller_symbol: null, callee_name: 'os', callee_file: null, kind: 'import', confidence: 'high' },
    { caller_file: 'a.py', caller_symbol: null, callee_name: 'pkg.mod', callee_file: 'pkg/mod.py', kind: 'import', confidence: 'high' },
    { caller_file: 'a.py', caller_symbol: null, callee_name: 'external.lib', callee_file: null, kind: 'import', confidence: 'high' },
    { caller_file: 'a.py', caller_symbol: null, callee_name: 'json', callee_file: null, kind: 'import', confidence: 'high' },
    { caller_file: 'a.py', caller_symbol: null, callee_name: 'pkg.other', callee_file: 'pkg/other.py', kind: 'import', confidence: 'high' },
  ]);
});

test('extractEdges: relative imports resolve against the importing file directory', () => {
  const src = 'from .sibling import x\nfrom ..pkg_top.mod import y\n';
  const edges = extractEdges(
    src,
    'pkg/a.py',
    new Map(),
    new Set(['pkg/a.py', 'pkg/sibling.py', 'pkg_top/mod.py'])
  );
  assert.deepEqual(
    edges.map((e) => [e.callee_name, e.callee_file]),
    [
      ['.sibling', 'pkg/sibling.py'],
      ['..pkg_top.mod', 'pkg_top/mod.py'],
    ]
  );
});

test('extractEdges: call edges need a unique definition, attribute takes last segment', () => {
  const src = [
    'import os',
    '',
    'unique_fn()', // module-level call: not inside any function -> no edge
    '',
    'def caller():',
    '    unique_fn()', // unique in b.py -> edge
    '    unique_fn()', // duplicate: deduped
    '    ambiguous()', // count 2 -> no edge
    '    unknown_fn()', // count 0 -> no edge
    '    local_fn()', // defined in a.py itself -> same-file edge (MVP-2)
    '    svc.process()', // attribute: name 'process', unique in c.py -> edge
    '    factory()()', // callee is a call expression -> skipped
    '',
    'def local_fn():',
    '    pass',
    '',
    'def nested_host():',
    '    def inner():',
    '        unique_fn()', // belongs to inner (innermost function), not nested_host
    '    return inner',
  ].join('\n');

  const symbolIndex = new Map([
    ['unique_fn', { file: 'b.py', count: 1 }],
    ['ambiguous', { file: 'b.py', count: 2 }],
    ['process', { file: 'c.py', count: 1 }],
    ['local_fn', { file: 'a.py', count: 1 }],
  ]);

  const edges = extractEdges(src, 'a.py', symbolIndex, new Set(['a.py', 'b.py', 'c.py']));

  assert.deepEqual(edges, [
    { caller_file: 'a.py', caller_symbol: null, callee_name: 'os', callee_file: null, kind: 'import', confidence: 'high' },
    { caller_file: 'a.py', caller_symbol: 'caller', callee_name: 'unique_fn', callee_file: 'b.py', kind: 'call', confidence: 'low' },
    { caller_file: 'a.py', caller_symbol: 'caller', callee_name: 'local_fn', callee_file: 'a.py', kind: 'call', confidence: 'low' },
    { caller_file: 'a.py', caller_symbol: 'caller', callee_name: 'process', callee_file: 'c.py', kind: 'call', confidence: 'low' },
    { caller_file: 'a.py', caller_symbol: 'inner', callee_name: 'unique_fn', callee_file: 'b.py', kind: 'call', confidence: 'low' },
  ]);
});
