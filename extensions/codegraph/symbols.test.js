// symbols.test.js - extractSymbols unit tests (tree-sitter python parsing).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols } from './parse.ts';

import { FIXTURE } from './fixtures.js';

test('extractSymbols: fixture yields Config/reload/fetch/inner with kinds, lines, signatures', () => {
  assert.deepEqual(extractSymbols(FIXTURE), [
    { name: 'Config', kind: 'class', line: 5, signature: 'class Config:' },
    { name: 'reload', kind: 'method', line: 7, signature: 'def reload(self) -> None: ...' },
    {
      name: 'fetch',
      kind: 'function',
      line: 9,
      signature: 'async def fetch(url: str, *, retry: int = 3) -> Optional[str]:',
    },
    { name: 'inner', kind: 'function', line: 10, signature: 'def inner():' },
  ]);
});

test('extractSymbols: fetch signature keeps parameter type annotation', () => {
  const fetchSym = extractSymbols(FIXTURE).find((s) => s.name === 'fetch');
  assert.ok(fetchSym, 'fetch symbol missing');
  assert.ok(fetchSym.signature.includes('url: str'));
});

test('extractSymbols: imports and module variables are not symbols', () => {
  assert.deepEqual(
    extractSymbols('import os\nfrom typing import Optional\n\nMAX = 10\n'),
    []
  );
});
