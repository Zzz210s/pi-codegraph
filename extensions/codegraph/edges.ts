// edges.ts - import/call edge extraction from an Analyzed parse.
// Pure module: no parsing, no fs, no store.
//
//   extractEdges(source, relFile, symbolIndex, pyPaths)  Edge[] out
//   edgesFromAnalysis(analysis, ...)                      internal, shared by indexRepo
//
// Edge semantics (unchanged from the original single-file indexer.ts):
// - import edges: kind 'import', confidence 'high', caller_symbol null,
//   callee_name the dotted module reference as written ('os', 'pkg.mod',
//   '.sibling'), callee_file the resolved repo-relative path or null for
//   external libraries. Duplicated imports within a file collapse to one edge.
// - call edges: kind 'call', confidence 'low', caller_symbol the innermost
//   enclosing function name. Kept only when the callee name maps to exactly
//   one definition in the whole repo (symbolIndex count === 1); the unique
//   definition may live in the same file (MVP-2). Direct self-recursion,
//   ambiguous and unknown callees produce no edge.
import type { Analyzed, Lang } from './parse.ts';
import { analyze } from './parse.ts';
import type { Edge } from './store.ts';

/** Whole-repo name -> unique-definition info used to disambiguate call edges. */
export interface SymbolNameEntry {
  file: string;
  count: number;
}

// Resolve a dotted module reference to a repo-relative .py path, or null when
// it points outside the repo or at a module the repo does not contain.
// Absolute names ('pkg.mod') resolve from the repo root; relative names
// ('.mod', '..pkg_top.mod') resolve from the importing file's directory.
function resolveImport(
  moduleText: string,
  relFile: string,
  pyPaths: Set<string>
): string | null {
  let dotted = moduleText;
  const dots = /^[.]*/.exec(moduleText)![0].length;
  if (dots > 0) {
    const parts = relFile.split('/');
    parts.pop(); // drop the importing file name -> its directory
    for (let i = 1; i < dots; i++) {
      if (parts.length === 0) return null; // '..' above the repo root
      parts.pop();
    }
    dotted = [...parts, moduleText.slice(dots)].filter((p) => p !== '').join('.');
  }
  if (dotted === '') return null;
  const base = dotted.replace(/\./g, '/');
  if (pyPaths.has(`${base}.py`)) return `${base}.py`;
  if (pyPaths.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return null; // external library or unknown module
}

// Resolve a TypeScript/TSX relative import specifier ('./mod', '../pkg/mod')
// against the set of repo-relative source paths; non-relative specifiers are
// external packages and resolve to null.
function resolveTsImport(
  specifier: string,
  relFile: string,
  paths: Set<string>
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const dir = relFile.split('/').slice(0, -1); // importing file's directory
  const target = [...dir, ...specifier.split('/')].filter((p) => p !== '' && p !== '.');
  for (let i = target.length - 1; i >= 0; i--) {
    if (target[i] === '..') {
      target.splice(i, 2);
    }
  }
  const base = target.join('/');
  if (base === '') return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (paths.has(candidate)) return candidate;
  }
  return null;
}

/** How one language's import refs turn into repo-relative target paths
 * (or null for external/unresolvable refs). */
export type ImportRefResolver = (ref: string, relFile: string) => string | null;

/** Build the import resolver for `lang` given every repo-relative source path. */
export function importResolverFor(lang: Lang, paths: Set<string>): ImportRefResolver {
  switch (lang) {
    case 'python':
      return (ref, relFile) => resolveImport(ref, relFile, paths);
    case 'typescript':
    case 'tsx':
      return (ref, relFile) => resolveTsImport(ref, relFile, paths);
    case 'go':
    case 'java':
      // directory- or package-level imports: not resolved to files (best-effort)
      return () => null;
  }
}

// Build Edge[] from an Analyzed parse (no parsing here). Import edges come out
// in document order, call edges per enclosing function in tree order.
export function edgesFromAnalysis(
  analysis: Analyzed,
  relFile: string,
  symbolIndex: Map<string, SymbolNameEntry>,
  pyPaths: Set<string>,
  resolveRef: ImportRefResolver = (ref, f) => resolveImport(ref, f, pyPaths)
): Edge[] {
  const edges: Edge[] = [];

  // import edges (document order, deduped during analysis)
  for (const ref of analysis.imports) {
    const calleeFile = resolveRef(ref, relFile);
    edges.push({
      caller_file: relFile,
      caller_symbol: null,
      callee_name: ref,
      callee_file: calleeFile,
      kind: 'import',
      confidence: 'high',
    });
  }

  // call edges (per function_definition, deduped during analysis)
  for (const { caller, callee } of analysis.calls) {
    const entry = symbolIndex.get(callee);
    // unique definition in the repo (same file allowed); direct
    // self-recursion (fn calling itself) stays out
    if (!entry || entry.count !== 1 || caller === callee) continue;
    edges.push({
      caller_file: relFile,
      caller_symbol: caller,
      callee_name: callee,
      callee_file: entry.file,
      kind: 'call',
      confidence: 'low',
    });
  }

  return edges;
}

/** Extract import and call edges from one Python source file. Pure function.
 * `pyPaths` (all repo-relative .py paths) drives import resolution; without
 * it every import resolves to null. */
export function extractEdges(
  source: string,
  relFile: string,
  symbolIndex: Map<string, SymbolNameEntry>,
  pyPaths: Set<string> = new Set()
): Edge[] {
  return edgesFromAnalysis(analyze(source), relFile, symbolIndex, pyPaths);
}
