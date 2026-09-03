// store.ts - SQLite-backed storage for the codegraph extension.
// Pure Node module: no pi runtime dependency. Indexed by indexer, queried by find.
//
// Types and the open handle live here; prepared statements and the Store
// method implementations live in store-io.ts.
//
// Tables:
//   files   (path, hash)          - content hash per file, used to skip re-parsing
//   symbols (name, kind, line, signature, file) - symbols extracted per file
//   edges   (caller_file, caller_symbol, callee_name, callee_file, kind,
//            confidence) - import/call edges extracted per file (MVP-1)
//
// Usage:
//   const store = openStore('index.db');
//   store.upsertFile('/a.py', 'sha256...');
//   store.upsertSymbols('/a.py', [{ name: 'foo', kind: 'function', line: 1, signature: 'foo(a)' }]);
//   store.upsertEdges('/a.py', [edge, ...]);
//   store.findSymbols('foo', 'prefix');
//   store.close();
import Database from 'better-sqlite3';
import { createSchema, createStoreIO } from './store-io.ts';

export interface Symbol {
  name: string;
  kind: 'function' | 'class' | 'method';
  line: number;
  signature: string | null;
}

/**
 * A directed code relationship extracted from one caller file.
 * - import edges: caller_symbol is null, confidence 'high', callee_file is
 *   the resolved repo-relative path or null for external libraries.
 * - call edges: caller_symbol is the enclosing function/method name,
 *   confidence 'low', callee_file is the unique-definition file or null.
 */
export interface Edge {
  caller_file: string;
  caller_symbol: string | null;
  callee_name: string;
  callee_file: string | null;
  kind: 'import' | 'call';
  confidence: 'high' | 'low';
}

export interface Store {
  /** Insert or update the content hash for a file path. */
  upsertFile(path: string, hash: string): void;
  /**
   * Given files that exist on disk now, return the paths that must be
   * re-parsed: not yet in the store, or whose stored hash differs.
   */
  getFilesChanged(files: { path: string; hash: string }[]): string[];
  /** Replace all symbols belonging to one file (deletes the old rows first). */
  upsertSymbols(file: string, symbols: Symbol[]): void;
  /**
   * Replace all edges whose caller is `file` (deletes the old rows first,
   * both operations in one transaction).
   */
  upsertEdges(file: string, edges: Edge[]): void;
  /** All edges whose caller_file is one of `files`. Empty input -> []. */
  getEdgesFrom(files: string[]): Edge[];
  /** All edges whose caller_file equals `file` exactly. */
  getEdgesFromFile(file: string): Edge[];
  /** All edges whose callee_name equals `name` exactly. */
  getEdgesToName(name: string): Edge[];
  /** All edges whose callee_file equals `file` exactly. */
  getEdgesToFile(file: string): Edge[];
  /** Every stored edge, ordered by caller_file then callee_name. */
  getAllEdges(): Edge[];
  /**
   * Search symbols by name. `mode` selects matching:
   *   'exact'     name = query
   *   'prefix'    name starts with query (ASCII case-insensitive)
   *   'substring' name contains query (ASCII case-insensitive)
   * Optional `kind` restricts results to that symbol kind.
   * Rows are ordered by file, then line. LIKE wildcards in the query
   * (% and _) are treated as literal characters. An unknown mode throws
   * `Error('invalid mode: <mode>')`.
   */
  findSymbols(
    name: string,
    mode: 'exact' | 'prefix' | 'substring',
    kind?: Symbol['kind']
  ): (Symbol & { file: string })[];
  /** Close the database handle. */
  close(): void;
}

export function openStore(dbPath: string): Store {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    // Opening a garbage file is lazy in SQLite; the first statement is what
    // actually fails - so schema creation doubles as the integrity probe.
    createSchema(db);
  } catch (e) {
    try {
      db?.close();
    } catch {
      // already closed or never usable
    }
    const detail = (e as Error).message.split('\n', 1)[0];
    throw new Error(
      `索引库损坏,请删除 .codegraph/ 后运行 /reindex (${detail})`
    );
  }
  const io = createStoreIO(db);
  return {
    ...io,
    close() {
      db!.close();
    },
  };
}
