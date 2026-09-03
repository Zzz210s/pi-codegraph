// pagerank.ts - file-level importance ranking for the codegraph extension.
// Pure Node module: no fs, no pi runtime dependency.
//
//   pageRank(nodes, links, opts?)   standard PageRank over any string nodes;
//                                   parallel links count as weight, dangling
//                                   nodes redistribute uniformly, scores sum
//                                   to 1.
//   getFileRanks(store)             convenience: nodes = every file with
//                                   symbols or edges, links = edges whose
//                                   callee_file resolved (imports + calls).
//
// Consumers: code_map file ordering (map.ts) and code_find intra-tier
// ordering (find.ts). At current index scale (aider: 147 files, ~2.4k edges)
// one evaluation is single-digit milliseconds, so callers compute per query;
// a persistent hot-path cache stays deferred (see specs MVP-2 plan).
import type { Store } from './store.ts';

export interface RankOptions {
  /** Damping factor, 0 < d < 1 (default 0.85). */
  damping?: number;
  /** Max power-iteration rounds (default 30). */
  iterations?: number;
  /** Early-stop L1 tolerance (default 1e-6). */
  tol?: number;
}

export interface Link {
  from: string;
  to: string;
}

export function pageRank(
  nodes: string[],
  links: Link[],
  opts: RankOptions = {}
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 30;
  const tol = opts.tol ?? 1e-6;

  const nodeSet = new Set<string>(nodes);
  for (const l of links) {
    nodeSet.add(l.from);
    nodeSet.add(l.to);
  }
  const n = nodeSet.size;
  if (n === 0) return new Map();

  // Weighted adjacency: parallel links between the same pair accumulate.
  const out = new Map<string, Map<string, number>>();
  const outWeight = new Map<string, number>();
  for (const l of links) {
    let targets = out.get(l.from);
    if (!targets) {
      targets = new Map();
      out.set(l.from, targets);
    }
    const w = (targets.get(l.to) ?? 0) + 1;
    targets.set(l.to, w);
    outWeight.set(l.from, (outWeight.get(l.from) ?? 0) + 1);
  }

  let rank = new Map<string, number>();
  for (const f of nodeSet) rank.set(f, 1 / n);

  for (let round = 0; round < iterations; round++) {
    // Dangling mass (nodes without out-edges) is spread uniformly, which
    // keeps the scores a probability distribution.
    let dangling = 0;
    for (const f of nodeSet) {
      if (!outWeight.has(f)) dangling += rank.get(f)!;
    }
    const base = (1 - damping) / n + (damping * dangling) / n;

    const next = new Map<string, number>();
    for (const f of nodeSet) next.set(f, base);
    for (const [from, targets] of out) {
      const share = (damping * rank.get(from)!) / outWeight.get(from)!;
      for (const [to, w] of targets) {
        next.set(to, next.get(to)! + share * w);
      }
    }

    let diff = 0;
    for (const f of nodeSet) diff += Math.abs(next.get(f)! - rank.get(f)!);
    rank = next;
    if (diff < tol) break;
  }
  return rank;
}

/**
 * PageRank over the file graph of one store: every file holding symbols or
 * touching an edge is a node; every edge with a resolved callee_file becomes
 * a directed link caller_file -> callee_file (import and call edges both
 * count). Edges to external libraries (callee_file null) are ignored.
 */
export function getFileRanks(store: Store): Map<string, number> {
  const files = new Set<string>();
  for (const s of store.findSymbols('', 'prefix')) files.add(s.file);

  const links: Link[] = [];
  for (const e of store.getAllEdges()) {
    files.add(e.caller_file);
    if (e.callee_file !== null) {
      files.add(e.callee_file);
      links.push({ from: e.caller_file, to: e.callee_file });
    }
  }
  return pageRank([...files], links);
}
