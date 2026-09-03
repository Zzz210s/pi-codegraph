// doctor.test.js - unit tests for doctor.ts (/code doctor report).
// Dependency loading is stubbed so tests never touch real npm packages.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { doctor } from './doctor.ts';
import { indexRepo } from './indexer.ts';

const ALL_OK = () => () => ({});

test('doctor: missing index asks for /reindex, deps all OK', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-doctor-'));
  try {
    const out = doctor(root, { tryLoad: ALL_OK() });
    assert.match(out, /node: v\d+/);
    assert.match(out, /依赖 tree-sitter: OK/);
    assert.match(out, /依赖 better-sqlite3: OK/);
    assert.match(out, /索引: 不存在/);
    assert.match(out, /\/reindex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: fresh index reports counts, language distribution, freshness', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-doctor2-'));
  try {
    writeFileSync(join(root, 'a.py'), 'def one(): pass\n');
    writeFileSync(join(root, 'b.ts'), 'export function two(): void {}\n');
    indexRepo(root);

    const out = doctor(root, { tryLoad: ALL_OK() });
    assert.match(out, /索引: 存在/);
    assert.match(out, /文件 2 \| 符号 2 \| 边 \d+/);
    assert.match(out, /语言分布: py 1, ts 1/);
    assert.match(out, /新鲜/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: new files on disk make the index stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-doctor3-'));
  try {
    writeFileSync(join(root, 'a.py'), 'def one(): pass\n');
    indexRepo(root);
    writeFileSync(join(root, 'later.py'), 'def late(): pass\n');

    const out = doctor(root, { tryLoad: ALL_OK() });
    assert.match(out, /待更新|陈旧/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: garbage db file is reported as corrupt', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-doctor4-'));
  try {
    mkdirSync(join(root, '.codegraph'));
    writeFileSync(join(root, '.codegraph', 'index.sqlite'), 'this is not a sqlite db');
    const out = doctor(root, { tryLoad: ALL_OK() });
    assert.match(out, /损坏/);
    assert.match(out, /删除 .*\.codegraph 后运行 \/reindex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: failing dependency is reported FAIL with fix hint', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-doctor5-'));
  try {
    const tryLoad = (name) => {
      if (name === 'tree-sitter-go') throw new Error('MODULE_NOT_FOUND');
      return {};
    };
    const out = doctor(root, { tryLoad });
    assert.match(out, /依赖 tree-sitter-go: FAIL/);
    assert.match(out, /npm install/);
    assert.match(out, /依赖 tree-sitter: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: gitignore check only inside git repos', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-doctor6-'));
  try {
    // no .git dir -> no gitignore line at all
    assert.ok(!doctor(root, { tryLoad: ALL_OK() }).includes('.gitignore'));

    // git repo without the entry -> WARN suggesting it
    mkdirSync(join(root, '.git'));
    assert.match(doctor(root, { tryLoad: ALL_OK() }), /\.gitignore: 未含 \.codegraph/);

    // with the entry -> OK
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.codegraph/\n');
    assert.match(doctor(root, { tryLoad: ALL_OK() }), /\.gitignore: 已含 \.codegraph/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
