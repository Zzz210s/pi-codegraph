// map.ts - code_map query logic: an aider-style condensed repo map.
// Pure Node module: no pi runtime dependency.
//
//   codeMap(root, opts?)  read <root>/.codegraph/index.sqlite and return a
//                         multi-line map for the LLM: files ordered by
//                         PageRank (most central first), each file followed by
//                         its `  line  kind  name  signature` symbols, filled
//                         until a token budget runs out.
//
// Token estimate per output line: ceil(len/4) + 1 (chars-to-tokens 4:1 plus a
// per-line overhead) - deliberately coarse; the budget only needs to be a
// stable size control, not an exact tokenizer.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getFileRanks } from './pagerank.ts';
import { openStore } from './store.ts';

export interface MapOptions {
  /** Max estimated tokens of map output; clamped to 200..8000 (default 1500). */
  token_budget?: number;
}

const DEFAULT_BUDGET = 1500;
const MIN_BUDGET = 200;
const MAX_BUDGET = 8000;

function lineTokens(line: string): number {
  return Math.ceil(line.length / 4) + 1;
}

function symbolLine(s: { line: number; kind: string; name: string; signature: string | null }): string {
  const head = `  ${s.line}  ${s.kind}  ${s.name}`;
  return s.signature === null ? head : `${head}  ${s.signature}`;
}

export function codeMap(root: string, opts: MapOptions = {}): string {
  const raw = opts.token_budget ?? DEFAULT_BUDGET;
  const budget = Math.min(
    MAX_BUDGET,
    Math.max(MIN_BUDGET, Math.floor(Number.isFinite(raw) ? raw : DEFAULT_BUDGET))
  );

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
    const symbols = store.findSymbols('', 'prefix'); // '' prefix -> every row
    if (symbols.length === 0) {
      return '索引为空,没有任何符号。请确认仓库内有受支持的源码文件后 /reindex';
    }

    const byFile = new Map<string, typeof symbols>();
    for (const s of symbols) {
      let list = byFile.get(s.file);
      if (!list) {
        list = [];
        byFile.set(s.file, list);
      }
      list.push(s);
    }

    const ranks = getFileRanks(store);
    // Highest rank first; file name as a deterministic tiebreak.
    const files = [...byFile.keys()].sort(
      (a, b) => (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0) || a.localeCompare(b)
    );

    const lines: string[] = [];
    let used = 0;
    let truncated = false;
    let filesShown = 0;
    let symbolsShown = 0;

    fill: for (const file of files) {
      const fileCost = lineTokens(file);
      if (used + fileCost > budget) {
        truncated = true;
        break;
      }
      lines.push(file);
      used += fileCost;
      filesShown++;
      for (const s of byFile.get(file)!) {
        const cost = lineTokens(symbolLine(s));
        if (used + cost > budget) {
          truncated = true;
          break fill;
        }
        lines.push(symbolLine(s));
        used += cost;
        symbolsShown++;
      }
    }

    const out = [
      `仓库地图: ${filesShown} 文件 / ${symbolsShown} 符号 / ${used} tokens(预算 ${budget})`,
      ...lines,
    ];
    if (truncated) out.push('... 预算截断');
    return out.join('\n');
  } finally {
    store.close();
  }
}
