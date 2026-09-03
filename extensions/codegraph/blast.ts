// blast.ts - bidirectional reachability (code_impact) over the edge store.
// Pure Node module: no pi runtime dependency.
//
//   blastRadius(store, target, depth?)  every file/symbol reachable from a
//                                       file and/or symbol, plus the
//                                       test-file subset.
//
// The BFS frontier is either a whole file (import edges are file-level) or a
// (file, symbol) call endpoint; each node is expanded both outward (edges the
// file/symbol produces) and inward (edges that point at it). Depth is counted
// in node hops, clamped to MAX_DEPTH. files/symbols are deduped and sorted.
import type { Edge, Store } from './store.ts';
import { clampDepth, DEFAULT_DEPTH } from './trace.ts';

export interface Blast {
  files: string[];
  symbols: string[];
  tests: string[];
}

export interface BlastTarget {
  file?: string;
  symbol?: string;
}

/** True when a file path looks like a test file. */
function isTestFile(file: string): boolean {
  const base = file.split('/').pop() ?? '';
  return (
    file.includes('test_') ||
    file.includes('tests/') ||
    base.startsWith('test_') ||
    base.endsWith('_test.py')
  );
}

export function blastRadius(
  store: Store,
  target: BlastTarget,
  depth: number = DEFAULT_DEPTH
): Blast {
  const maxDepth = clampDepth(depth);
  const files = new Set<string>();
  const symbols = new Set<string>();
  const visited = new Set<string>();
  const queue: {
    kind: 'file' | 'symbol';
    file: string | null;
    symbol: string | null;
    depth: number;
  }[] = [];

  // Symbol-level edges only: import edges carry no symbol endpoints.
  const recordCall = (edge: Edge): void => {
    if (edge.kind !== 'call') return;
    if (edge.caller_symbol !== null) symbols.add(edge.caller_symbol);
    symbols.add(edge.callee_name);
  };

  const visitFile = (file: string, d: number): void => {
    const key = `F\0${file}`;
    if (visited.has(key)) return;
    visited.add(key);
    files.add(file);
    queue.push({ kind: 'file', file, symbol: null, depth: d });
  };

  const visitSymbol = (file: string | null, symbol: string, d: number): void => {
    const key = `S\0${file ?? ''}\0${symbol}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (file !== null) files.add(file);
    queue.push({ kind: 'symbol', file, symbol, depth: d });
  };

  if (target.file !== undefined) visitFile(target.file, 0);
  if (target.symbol !== undefined) {
    for (const def of store.findSymbols(target.symbol, 'exact')) {
      visitFile(def.file, 0);
      visitSymbol(def.file, target.symbol, 0);
    }
    // Trace incoming edges to the name even when it has no definition file.
    visitSymbol(null, target.symbol, 0);
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= maxDepth) continue;
    const nextDepth = item.depth + 1;

    if (item.kind === 'file' && item.file !== null) {
      // outward: everything this file uses
      for (const edge of store.getEdgesFromFile(item.file)) {
        recordCall(edge);
        if (edge.callee_file !== null) {
          visitFile(edge.callee_file, nextDepth);
          if (edge.kind === 'call') {
            visitSymbol(edge.callee_file, edge.callee_name, nextDepth);
          }
        }
      }
      // inward: everything that uses this file
      for (const edge of store.getEdgesToFile(item.file)) {
        recordCall(edge);
        visitFile(edge.caller_file, nextDepth);
        if (edge.kind === 'call' && edge.caller_symbol !== null) {
          visitSymbol(edge.caller_file, edge.caller_symbol, nextDepth);
        }
      }
    } else if (item.kind === 'symbol' && item.symbol !== null) {
      // inward: edges whose callee name is this symbol
      for (const edge of store.getEdgesToName(item.symbol)) {
        recordCall(edge);
        visitFile(edge.caller_file, nextDepth);
        if (edge.kind === 'call' && edge.caller_symbol !== null) {
          visitSymbol(edge.caller_file, edge.caller_symbol, nextDepth);
        }
      }
      // outward: this symbol's own calls, from its definition file
      if (item.file !== null) {
        for (const edge of store.getEdgesFromFile(item.file)) {
          if (edge.kind !== 'call' || edge.caller_symbol !== item.symbol) continue;
          recordCall(edge);
          if (edge.callee_file !== null) {
            visitFile(edge.callee_file, nextDepth);
            visitSymbol(edge.callee_file, edge.callee_name, nextDepth);
          }
        }
      }
    }
  }

  return {
    files: [...files].sort(),
    symbols: [...symbols].sort(),
    tests: [...files].filter(isTestFile).sort(),
  };
}
