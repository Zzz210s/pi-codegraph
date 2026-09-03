// parse-java.test.js - analyze() extraction tests for Java.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from './parse.ts';

const JAVA_SRC = `package com.example;

import java.util.List;

public class Greeter {
    private String name;

    public String greet() {
        return helper(name);
    }

    String helper(String s) {
        return s.trim();
    }
}

class Main {
    void run() {
        Greeter g = new Greeter();
        g.greet();
    }
}
`;

test('analyze java: classes and methods', () => {
  const a = analyze(JAVA_SRC, 'java');

  assert.deepEqual(
    a.symbols.map((s) => `${s.name}:${s.kind}:${s.line}`),
    [
      'Greeter:class:5',
      'greet:method:8',
      'helper:method:12',
      'Main:class:17',
      'run:method:18',
    ]
  );
  assert.equal(a.symbols[0].signature, 'public class Greeter {');
});

test('analyze java: imports are dotted scoped names', () => {
  const a = analyze(JAVA_SRC, 'java');
  assert.deepEqual(a.imports, ['java.util.List']);
});

test('analyze java: method invocations and object creations', () => {
  const a = analyze(JAVA_SRC, 'java');
  assert.deepEqual(a.calls, [
    { caller: 'greet', callee: 'helper' },
    { caller: 'helper', callee: 'trim' },
    { caller: 'run', callee: 'Greeter' },
    { caller: 'run', callee: 'greet' },
  ]);
});

test('analyze java: static import and interface parse without crash', () => {
  const a = analyze(
    'import static java.lang.Math.max;\n\ninterface I {\n  void doIt();\n}\n',
    'java'
  );
  // interface method declarations count as symbols (callable definitions)
  assert.deepEqual(
    a.symbols.map((s) => `${s.name}:${s.kind}`),
    ['I:class', 'doIt:method']
  );
  assert.deepEqual(a.imports, ['java.lang.Math.max']);
  assert.deepEqual(a.calls, []); // no method body anywhere
});
