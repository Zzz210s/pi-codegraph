// indexer.ts - incremental repo indexing: scan source files (.py/.ts/.tsx/
// .go/.java), hash, re-parse only changed ones, persist symbols + edges to
// <root>/.codegraph/index.sqlite.
//
//   indexRepo(root, opts?)  the only public entry here
//
// Parsing lives in parse.ts (single-walk analyze per language); edge
// construction lives in edges.ts. This file owns the two-pass store protocol:
//   1. sha1(content) per file; store.getFilesChanged() decides what to re-parse
//   2. per changed file: upsertSymbols then upsertEdges + upsertFile (a changed
//      file with zero symbols still records its hash and clears old rows)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Analyzed, Lang } from './parse.ts';
import { analyze, langFromPath } from './parse.ts';
import { edgesFromAnalysis, importResolverFor, type SymbolNameEntry } from './edges.ts';
import { openStore } from './store.ts';

// Re-exported so existing imports of './indexer.ts' keep working; the pure
// extraction functions themselves live in parse.ts / edges.ts.
export { extractSymbols } from './parse.ts';
export { extractEdges, type SymbolNameEntry } from './edges.ts';

// Directory names never scanned for sources (build output, deps, caches).
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'vendor',
  'target',
  '.codegraph',
]);

// Source extensions recognized by the indexers (one grammar per language).
const EXTENSIONS = ['.py', '.ts', '.tsx', '.go', '.java'];

export interface IndexResult {
  /** Files parsed this run (new or changed since last run). */
  files: number;
  /** Total symbols in the store after this run. */
  symbols: number;
  /** Wall-clock duration of the run in milliseconds. */
  ms: number;
}

// Recursively collect absolute paths of supported source files.
function collectSourceFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir: skip, indexing is best-effort
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(full, out);
    } else if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
}

// Repo-relative path with forward slashes, independent of host OS.
function toRelPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** Scan `root` for supported source files (same rules as indexRepo). */
export function scanSourceFiles(root: string): string[] {
  const out: string[] = [];
  collectSourceFiles(root, out);
  out.sort(); // deterministic order regardless of readdir order
  return out;
}

/** Options for indexRepo. `readFile` is injectable so tests can simulate
 * files vanishing between the directory scan and the content read. */
export interface IndexOpts {
  readFile?: (absPath: string) => string;
}

export function indexRepo(root: string, opts?: IndexOpts): IndexResult {
  const startedAt = Date.now();
  const dbDir = join(root, '.codegraph');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'index.sqlite');
  const readFile = opts?.readFile ?? ((abs: string) => readFileSync(abs, 'utf8'));

  const sourceFiles = scanSourceFiles(root);

  const fileInfos: { rel: string; hash: string; content: string; lang: Lang }[] = [];
  for (const abs of sourceFiles) {
    let content: string;
    try {
      content = readFile(abs);
    } catch {
      continue; // vanished between scan and read: best-effort skip, silent
    }
    const rel = toRelPath(root, abs);
    fileInfos.push({
      rel,
      hash: createHash('sha1').update(content).digest('hex'),
      content,
      lang: langFromPath(rel)!, // collected precisely because it matched
    });
  }

  const store = openStore(dbPath);
  try {
    const changed = new Set(
      store.getFilesChanged(fileInfos.map((f) => ({ path: f.rel, hash: f.hash })))
    );
    // Pass 1: parse each changed file ONCE (analyze). Symbols refresh now and
    // must complete before the symbol index below so freshly extracted symbols
    // count towards call-edge disambiguation; the same parse is kept for pass 2.
    const analyzed = new Map<string, Analyzed>();
    for (const f of fileInfos) {
      if (!changed.has(f.rel)) continue;
      const a = analyze(f.content, f.lang);
      analyzed.set(f.rel, a);
      store.upsertSymbols(f.rel, a.symbols);
    }
    // Whole-repo name index (changed and unchanged files alike) + the set of
    // repo-relative source paths, both consumed by edge extraction.
    const allSymbols = store.findSymbols('', 'prefix'); // '' prefix -> every row
    const symbolIndex = new Map<string, SymbolNameEntry>();
    for (const s of allSymbols) {
      const entry = symbolIndex.get(s.name);
      if (entry) entry.count++;
      else symbolIndex.set(s.name, { file: s.file, count: 1 });
    }
    const allPaths = new Set(fileInfos.map((f) => f.rel));
    // Pass 2: refresh edges of every changed file from the pass-1 parse (edges
    // need the completed symbol index for callee disambiguation).
    for (const f of fileInfos) {
      if (!changed.has(f.rel)) continue;
      const resolver = importResolverFor(f.lang, allPaths);
      store.upsertEdges(f.rel, edgesFromAnalysis(analyzed.get(f.rel)!, f.rel, symbolIndex, allPaths, resolver));
      store.upsertFile(f.rel, f.hash); // even when nothing was extracted
    }
    return { files: changed.size, symbols: allSymbols.length, ms: Date.now() - startedAt };
  } finally {
    store.close();
  }
}
