// parse-typescript.test.js - analyze() extraction tests for TypeScript/TSX.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from './parse.ts';

const TS_SRC = `import { helper } from './util';
import * as ext from 'external-lib';

export class Greeter {
  greeting: string;

  greet(): string {
    return helper(this.greeting);
  }
}

export function main(): void {
  const f = (x: number) => helper(x);
  f(1);
  const g = new Greeter();
  g.greet();
}
`;

test('analyze typescript: symbols, imports, calls', () => {
  const a = analyze(TS_SRC, 'typescript');

  const brief = (s) => `${s.name}:${s.kind}:${s.line}`;
  assert.deepEqual(
    a.symbols.map(brief),
    ['Greeter:class:4', 'greet:method:7', 'main:function:12', 'f:function:13']
  );
  // signature = first line of the definition node text
  assert.equal(a.symbols[0].signature, 'class Greeter {');
  assert.equal(a.symbols[2].signature, 'function main(): void {');

  // imports in document order, quotes stripped, deduped
  assert.deepEqual(a.imports, ['./util', 'external-lib']);

  // call edges per enclosing function in tree order, deduped by caller+callee
  assert.deepEqual(a.calls, [
    { caller: 'greet', callee: 'helper' },
    { caller: 'main', callee: 'f' },
    { caller: 'main', callee: 'greet' },
    { caller: 'f', callee: 'helper' },
  ]);
});

const TSX_SRC = `import React from 'react';

export function App(): React.JSX.Element {
  return <div className="app">hi</div>;
}
`;

test('analyze tsx: parses JSX without crashing, extracts the function', () => {
  const a = analyze(TSX_SRC, 'tsx');
  assert.deepEqual(
    a.symbols.map((s) => `${s.name}:${s.kind}:${s.line}`),
    ['App:function:3']
  );
  assert.deepEqual(a.imports, ['react']);
  assert.deepEqual(a.calls, []); // JSX elements are not call edges
});

test('analyze typescript: module-level calls are not attributed to anyone', () => {
  const a = analyze(`import { u } from './u';\nu();\n`, 'typescript');
  assert.deepEqual(a.symbols, []);
  assert.deepEqual(a.calls, []);
  assert.deepEqual(a.imports, ['./u']);
});
