// store-io.ts - prepared statements and Store method implementations for
// SQLite storage. Pure Node module: no pi runtime dependency.
//
// createStoreIO(db) returns every Store method except close(); openStore in
// store.ts owns the Database handle, schema creation and the final object.
import type Database from 'better-sqlite3';
import type { Edge, Store, Symbol } from './store.ts';

// Escape SQLite LIKE wildcards so user input is matched literally.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// Write-time enum guards (the documented value contract of each table).
const SYMBOL_KINDS = new Set(['function', 'class', 'method']);
const EDGE_KINDS = new Set(['import', 'call']);
const CONFIDENCES = new Set(['high', 'low']);

const EDGE_COLUMNS =
  'caller_file, caller_symbol, callee_name, callee_file, kind, confidence';

export function createSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS symbols(
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      signature TEXT,
      file TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE TABLE IF NOT EXISTS edges(
      caller_file TEXT NOT NULL,
      caller_symbol TEXT,
      callee_name TEXT NOT NULL,
      callee_file TEXT,
      kind TEXT NOT NULL,
      confidence TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edges_caller_file ON edges(caller_file);
    CREATE INDEX IF NOT EXISTS idx_edges_callee_name ON edges(callee_name);
    CREATE INDEX IF NOT EXISTS idx_edges_callee_file ON edges(callee_file);
  `);
}

export function createStoreIO(db: Database.Database): Omit<Store, 'close'> {
  const upsertFileStmt = db.prepare(
    `INSERT INTO files(path, hash) VALUES (?, ?)
     ON CONFLICT(path) DO UPDATE SET hash = excluded.hash`
  );
  const getHashStmt = db.prepare('SELECT hash FROM files WHERE path = ?');
  const deleteFileSymbolsStmt = db.prepare('DELETE FROM symbols WHERE file = ?');
  const insertSymbolStmt = db.prepare(
    'INSERT INTO symbols(name, kind, line, signature, file) VALUES (?, ?, ?, ?, ?)'
  );
  const deleteFileEdgesStmt = db.prepare('DELETE FROM edges WHERE caller_file = ?');
  const insertEdgeStmt = db.prepare(
    `INSERT INTO edges(caller_file, caller_symbol, callee_name, callee_file, kind, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const replaceSymbols = db.transaction((file: string, symbols: Symbol[]) => {
    deleteFileSymbolsStmt.run(file);
    const insert = insertSymbolStmt;
    for (const s of symbols) {
      insert.run(s.name, s.kind, s.line, s.signature ?? null, file);
    }
  });

  const replaceEdges = db.transaction((file: string, edges: Edge[]) => {
    deleteFileEdgesStmt.run(file);
    for (const e of edges) {
      insertEdgeStmt.run(
        file,
        e.caller_symbol ?? null,
        e.callee_name,
        e.callee_file ?? null,
        e.kind,
        e.confidence
      );
    }
  });

  return {
    upsertFile(path, hash) {
      upsertFileStmt.run(path, hash);
    },

    getFilesChanged(files) {
      const changed: string[] = [];
      for (const f of files) {
        const row = getHashStmt.get(f.path) as { hash: string } | undefined;
        if (!row || row.hash !== f.hash) changed.push(f.path);
      }
      return changed;
    },

    upsertSymbols(file, symbols) {
      for (const s of symbols) {
        if (!SYMBOL_KINDS.has(s.kind)) throw new Error(`invalid kind: ${s.kind}`);
      }
      replaceSymbols(file, symbols);
    },

    upsertEdges(file, edges) {
      for (const e of edges) {
        if (!EDGE_KINDS.has(e.kind)) throw new Error(`invalid edge kind: ${e.kind}`);
        if (!CONFIDENCES.has(e.confidence))
          throw new Error(`invalid confidence: ${e.confidence}`);
      }
      replaceEdges(file, edges);
    },

    getEdgesFrom(files) {
      if (files.length === 0) return [];
      const placeholders = files.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT ${EDGE_COLUMNS} FROM edges
           WHERE caller_file IN (${placeholders})
           ORDER BY caller_file, callee_name`
        )
        .all(...files);
      return rows as Edge[];
    },

    getEdgesFromFile(file) {
      const rows = db
        .prepare(
          `SELECT ${EDGE_COLUMNS} FROM edges
           WHERE caller_file = ?
           ORDER BY caller_file, callee_name`
        )
        .all(file);
      return rows as Edge[];
    },

    getEdgesToName(name) {
      const rows = db
        .prepare(
          `SELECT ${EDGE_COLUMNS} FROM edges
           WHERE callee_name = ?
           ORDER BY caller_file, callee_name`
        )
        .all(name);
      return rows as Edge[];
    },

    getEdgesToFile(file) {
      const rows = db
        .prepare(
          `SELECT ${EDGE_COLUMNS} FROM edges
           WHERE callee_file = ?
           ORDER BY caller_file, callee_name`
        )
        .all(file);
      return rows as Edge[];
    },

    getAllEdges() {
      const rows = db
        .prepare(
          `SELECT ${EDGE_COLUMNS} FROM edges
           ORDER BY caller_file, callee_name`
        )
        .all();
      return rows as Edge[];
    },

    findSymbols(name, mode, kind) {
      if (mode !== 'exact' && mode !== 'prefix' && mode !== 'substring') {
        throw new Error(`invalid mode: ${mode}`);
      }
      let where: string;
      let param: string;
      if (mode === 'exact') {
        where = 'name = ?';
        param = name;
      } else {
        const like = escapeLike(name);
        param = mode === 'prefix' ? like + '%' : '%' + like + '%';
        where = "name LIKE ? ESCAPE '\\'";
      }
      if (kind !== undefined) where += ' AND kind = ?';

      const rows = db
        .prepare(
          `SELECT name, kind, line, signature, file FROM symbols
           WHERE ${where}
           ORDER BY file, line`
        )
        .all(...(kind !== undefined ? [param, kind] : [param]));
      return rows as (Symbol & { file: string })[];
    },
  };
}
