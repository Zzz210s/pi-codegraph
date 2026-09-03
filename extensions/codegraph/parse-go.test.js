// parse-go.test.js - analyze() extraction tests for Go.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from './parse.ts';

const GO_SRC = `package main

import (
	"fmt"

	"myrepo/util"
)

type Server struct {
	Port int
}

type Handler interface {
	Do()
}

type PortAlias int

func NewServer() *Server {
	return &Server{}
}

func (s *Server) Start() error {
	fmt.Println("start")
	util.Setup(s.Port)
	return nil
}

func main() {
	s := NewServer()
	s.Start()
}
`;

test('analyze go: symbols (struct/interface only for type aliases)', () => {
  const a = analyze(GO_SRC, 'go');

  assert.deepEqual(
    a.symbols.map((s) => `${s.name}:${s.kind}:${s.line}`),
    [
      'Server:class:9',
      'Handler:class:13',
      'NewServer:function:19',
      'Start:method:23',
      'main:function:29',
    ]
  );
  // PortAlias (line 17, plain alias) is intentionally not a symbol
  assert.ok(!a.symbols.some((s) => s.name === 'PortAlias'));
});

test('analyze go: imports are unquoted spec paths in document order', () => {
  const a = analyze(GO_SRC, 'go');
  assert.deepEqual(a.imports, ['fmt', 'myrepo/util']);
});

test('analyze go: calls attribute to enclosing function, selector keeps last segment', () => {
  const a = analyze(GO_SRC, 'go');
  assert.deepEqual(a.calls, [
    { caller: 'Start', callee: 'Println' },
    { caller: 'Start', callee: 'Setup' },
    { caller: 'main', callee: 'NewServer' },
    { caller: 'main', callee: 'Start' },
  ]);
});

test('analyze go: single import form and no-call file', () => {
  const a = analyze('package p\n\nimport "fmt"\n\nvar x = 1\n', 'go');
  assert.deepEqual(a.symbols, []);
  assert.deepEqual(a.imports, ['fmt']);
  assert.deepEqual(a.calls, []);
});
