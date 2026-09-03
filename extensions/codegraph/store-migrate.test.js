// store-migrate.test.js - store.ts schema migration test (MVP-0 db upgrade)
// Run: node --test  (Node >= 24: native TS type stripping lets this .js file
// import store.ts directly with the explicit .ts extension)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.ts';
import Database from 'better-sqlite3';

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codegraph-store-'));
  dbPath = join(tmpDir, 'index.db');
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});


test('opening an MVP-0 database adds the edges table without disturbing it', () => {
  // simulate a database created by the old store: files + symbols only
  const oldDbPath = join(tmpDir, 'old.db');
  const raw = new Database(oldDbPath);
  raw.exec(`
    CREATE TABLE files(path TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE symbols(
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      signature TEXT,
      file TEXT NOT NULL
    );
    CREATE INDEX idx_symbols_name ON symbols(name);
  `);
  raw.prepare("INSERT INTO files(path, hash) VALUES ('/old.py', 'h1')").run();
  raw.prepare(
    "INSERT INTO symbols(name, kind, line, signature, file) VALUES ('legacy', 'function', 3, 'legacy()', '/old.py')"
  ).run();
  raw.close();

  const migrated = openStore(oldDbPath);
  try {
    // pre-existing data is intact
    assert.deepEqual(migrated.getFilesChanged([{ path: '/old.py', hash: 'h1' }]), []);
    assert.equal(migrated.findSymbols('legacy', 'exact').length, 1);

    // the edges table is now usable
    migrated.upsertEdges('/old.py', [
      {
        caller_file: '/old.py',
        caller_symbol: 'legacy',
        callee_name: 'helper',
        callee_file: '/h.py',
        kind: 'call',
        confidence: 'low',
      },
    ]);
    assert.equal(migrated.getEdgesFrom(['/old.py']).length, 1);
    assert.equal(migrated.getEdgesToName('helper').length, 1);
    assert.equal(migrated.getEdgesToFile('/h.py').length, 1);
  } finally {
    migrated.close();
  }
});
