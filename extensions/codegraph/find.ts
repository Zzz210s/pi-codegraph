// find.ts - code_find query logic for the codegraph extension.
// Pure Node module: no pi runtime dependency.
//
//   codeFind(root, query, opts?)  search <root>/.codegraph/index.sqlite and
//                                 return multi-line text for the LLM:
//                                 `file:line  kind  name  signature`
//
// Ordering: exact matches first, then prefix, then substring; WITHIN each
// tier rows are ordered by their file's PageRank centrality (descending,
// tiebreak file then line), so generic-word queries surface hub files before
// lexicographic neighbours. Rows matching several tiers are deduped to their
// highest tier. Results are truncated to top_k (default 20) after sorting.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openStore } from './store.ts';
import type { Symbol } from './store.ts';
import { getFileRanks } from './pagerank.ts';

export interface FindOptions {
  kind?: Symbol['kind'];
  top_k?: number;
}

const DEFAULT_TOP_K = 20;

function guidanceText(query: string): string {
  return `未找到符号 "${query}"。建议用 rg 做文本搜索。`;
}

function formatRow(row: Symbol & { file: string }): string {
  const head = `${row.file}:${row.line}  ${row.kind}  ${row.name}`;
  return row.signature === null ? head : `${head}  ${row.signature}`;
}

export function codeFind(root: string, query: string, opts: FindOptions = {}): string {
  // Empty query is invalid: take the no-results path instead of matching
  // everything (prefix "" would hit every symbol in the index).
  if (!query) return guidanceText(query);

  const dbPath = join(root, '.codegraph', 'index.sqlite');
  // Check before opening: better-sqlite3 would create an empty db otherwise.
  if (!existsSync(dbPath)) return `索引不存在,请先运行 /reindex ${root}`;

  let store;
  try {
    store = openStore(dbPath);
  } catch (e) {
    return (e as Error).message; // friendly corrupt-db hint from openStore
  }
  try {
    const ranks = getFileRanks(store);
    const byRank = (a: Symbol & { file: string }, b: Symbol & { file: string }) =>
      (ranks.get(b.file) ?? 0) - (ranks.get(a.file) ?? 0) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line;

    const seen = new Set<string>();
    const rows: (Symbol & { file: string })[] = [];
    for (const mode of ['exact', 'prefix', 'substring'] as const) {
      const tier = store.findSymbols(query, mode, opts.kind).sort(byRank);
      for (const row of tier) {
        const key = `${row.file}\0${row.name}\0${row.line}`;
        if (seen.has(key)) continue; // already reported in a higher tier
        seen.add(key);
        rows.push(row);
      }
    }
    if (rows.length === 0) return guidanceText(query);
    return rows.slice(0, opts.top_k ?? DEFAULT_TOP_K).map(formatRow).join('\n');
  } finally {
    store.close();
  }
}
