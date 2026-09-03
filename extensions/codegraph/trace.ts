// trace.ts - call graph traversals over the codegraph edge store (MVP-1).
// Pure Node module: no pi runtime dependency.
//
//   traceCallers(store, name, depth?)   upward BFS along getEdgesToName:
//                                       who calls `name`, transitively.
//   traceCallees(store, name, depth?)   downward BFS from `name`'s definition
//                                       file along its own call edges.
//
// Binding: depth is clamped to MAX_DEPTH (5), defaults to 2; a visited set of
// (file, symbol) pairs breaks cycles; results are sorted by depth then file.
import type { Store } from './store.ts';

export interface TraceNode {
  file: string;
  symbol: string | null;
  via: 'call' | 'import';
  depth: number;
}

export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 5;

// Negative depths behave like depth 0: only the seed node / seed file is
// reported, uniform with the other traversals.
export function clampDepth(depth: number): number {
  return Math.max(0, Math.min(depth, MAX_DEPTH));
}

export function sortByDepthThenFile(a: TraceNode, b: TraceNode): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return byFile;
  return (a.symbol ?? '').localeCompare(b.symbol ?? '');
}

/**
 * Upward traversal: everyone who calls `name`, transitively.
 *
 * The BFS frontier is symbol names. For each name, getEdgesToName(name)
 * returns every incoming edge, classified as:
 *   - call edge   -> the caller symbol is one trace node; the climb continues
 *     from that symbol's name.
 *   - import edge -> the caller is a whole file (caller_symbol null); the
 *     node carries symbol null and the climb continues from every symbol
 *     defined in that file (plan binding: 该文件的全部符号都算作候选 caller).
 */
export function traceCallers(
  store: Store,
  name: string,
  depth: number = DEFAULT_DEPTH
): TraceNode[] {
  const maxDepth = clampDepth(depth);
  if (maxDepth === 0) {
    // depth 0: only the seed node is reported (uniform with traceCallees /
    // blastRadius, which report the seed file).
    const defs = store.findSymbols(name, 'exact');
    if (defs.length === 0) return [];
    return [{ file: defs[0].file, symbol: name, via: 'call', depth: 0 }];
  }

  const nodes: TraceNode[] = [];
  const visited = new Set<string>();
  const queuedNames = new Set<string>([name]);
  const queue: { name: string; depth: number }[] = [{ name, depth: 0 }];

  // Cache of symbol names per file for import climbs (plan binding: every
  // symbol defined in the importing file is a candidate caller).
  const fileSymbols = new Map<string, string[]>();
  const symbolsDefinedIn = (file: string): string[] => {
    let names = fileSymbols.get(file);
    if (names === undefined) {
      names = store
        .findSymbols('', 'prefix')
        .filter((s) => s.file === file)
        .map((s) => s.name);
      fileSymbols.set(file, names);
    }
    return names;
  };

  while (queue.length > 0) {
    const { name: current, depth: d } = queue.shift()!;
    if (d >= maxDepth) continue;
    const nextDepth = d + 1;
    for (const edge of store.getEdgesToName(current)) {
      if (edge.kind === 'call' && edge.caller_symbol !== null) {
        const key = `${edge.caller_file}\0${edge.caller_symbol}`;
        if (visited.has(key)) continue;
        visited.add(key);
        nodes.push({
          file: edge.caller_file,
          symbol: edge.caller_symbol,
          via: 'call',
          depth: nextDepth,
        });
        if (nextDepth < maxDepth && !queuedNames.has(edge.caller_symbol)) {
          queuedNames.add(edge.caller_symbol);
          queue.push({ name: edge.caller_symbol, depth: nextDepth });
        }
      } else {
        // import edge: the caller is the whole file; climb into it. Every
        // symbol defined in that file counts as a candidate caller (plan
        // binding), not only the ones that make calls here.
        const key = `${edge.caller_file}\0`;
        if (visited.has(key)) continue;
        visited.add(key);
        nodes.push({
          file: edge.caller_file,
          symbol: null,
          via: 'import',
          depth: nextDepth,
        });
        if (nextDepth < maxDepth) {
          for (const sname of symbolsDefinedIn(edge.caller_file)) {
            if (!queuedNames.has(sname)) {
              queuedNames.add(sname);
              queue.push({ name: sname, depth: nextDepth });
            }
          }
        }
      }
    }
  }
  return nodes.sort(sortByDepthThenFile);
}

/**
 * Downward traversal: what `name` transitively calls.
 *
 * Starts at `name`'s unique definition (findSymbols exact, first result) and
 * walks that file's call edges. For each unique callee name the traversal
 * recurses from the callee's definition file: the edge's own callee_file when
 * set, otherwise the store's unique definition. Callees the indexer left
 * unresolved (callee_file null - external or ambiguous) do not descend.
 * Import edges are never followed.
 */
export function traceCallees(
  store: Store,
  name: string,
  depth: number = DEFAULT_DEPTH
): TraceNode[] {
  const maxDepth = clampDepth(depth);
  const defs = store.findSymbols(name, 'exact');
  if (defs.length === 0) return [];
  const startFile = defs[0].file;
  if (maxDepth === 0) {
    // depth 0: only the seed node is reported (uniform with traceCallers /
    // blastRadius, which report the seed file).
    return [{ file: startFile, symbol: name, via: 'call', depth: 0 }];
  }

  const nodes: TraceNode[] = [];
  const visited = new Set<string>([`${startFile}\0${name}`]);
  const queue: { file: string; name: string; depth: number }[] = [
    { file: startFile, name, depth: 0 },
  ];

  while (queue.length > 0) {
    const { file, name: current, depth: d } = queue.shift()!;
    if (d >= maxDepth) continue;
    const nextDepth = d + 1;
    const uniqueCallees = new Set<string>();
    for (const edge of store.getEdgesFromFile(file)) {
      if (edge.kind !== 'call') continue;
      if (uniqueCallees.has(edge.callee_name)) continue;
      uniqueCallees.add(edge.callee_name);
      const calleeDefs = store.findSymbols(edge.callee_name, 'exact');
      // Prefer the edge's own resolved callee_file. When the indexer left it
      // null (external, or ambiguous with several defs), fall back to the
      // store's unique definition only; ambiguous names are never guessed and
      // do not descend.
      const calleeFile =
        edge.callee_file !== null
          ? edge.callee_file
          : calleeDefs.length === 1
            ? calleeDefs[0].file
            : null;
      if (calleeFile === null) continue; // external/ambiguous: no file to report
      const key = `${calleeFile}\0${edge.callee_name}`;
      if (visited.has(key)) continue;
      visited.add(key);
      nodes.push({ file: calleeFile, symbol: edge.callee_name, via: 'call', depth: nextDepth });
      if (nextDepth < maxDepth) {
        queue.push({ file: calleeFile, name: edge.callee_name, depth: nextDepth });
      }
    }
  }
  return nodes.sort(sortByDepthThenFile);
}
