// parse.ts - language dispatch for tree-sitter source analysis.
// Pure module: no fs, no store, no pi runtime dependency.
//
//   analyze(source, lang?)   one tree-sitter parse -> { symbols, imports, calls }
//   extractSymbols(source)   thin wrapper returning just the symbols
//   langFromPath(relPath)    '.py'/'.ts'/... -> Lang, anything else -> null
//
// Per-language extractors live in parse-<lang>.ts files; this file only
// defines the shared shapes (DefNode / Analyzed) and dispatches. Keeping the
// dispatch separate is what lets each language stay a small module
// (global rule: every code file <= 200 lines).
import type { Symbol } from './store.ts';

// Minimal structural type for the tree-sitter nodes we touch (avoids coupling
// to the binding's own .d.ts shape).
export interface DefNode {
  type: string;
  text: string;
  parent: DefNode | null;
  namedChildren: DefNode[];
  startPosition: { row: number };
  childForFieldName(field: string): DefNode | null;
}

export type Lang = 'python' | 'typescript' | 'tsx' | 'go' | 'java';

/**
 * Result of a single tree-sitter parse of one source file. indexRepo keeps
 * these per changed file so symbols and edges share one parse.
 */
export interface Analyzed {
  /** Definitions in tree order. */
  symbols: Symbol[];
  /** Dotted module references in document order, duplicates collapsed. */
  imports: string[];
  /** Innermost-function call sites in tree order, duplicates collapsed. */
  calls: { caller: string; callee: string }[];
}

/** Map a repo-relative path to its language; null when unsupported. */
export function langFromPath(relPath: string): Lang | null {
  if (relPath.endsWith('.py')) return 'python';
  if (relPath.endsWith('.ts')) return 'typescript';
  if (relPath.endsWith('.tsx')) return 'tsx';
  if (relPath.endsWith('.go')) return 'go';
  if (relPath.endsWith('.java')) return 'java';
  return null;
}

// Language extractors, one per grammar, each in its own small module.
import { analyzeGo } from './parse-go.ts';
import { analyzeJava } from './parse-java.ts';
import { analyzePython } from './parse-python.ts';
import { analyzeTypescript } from './parse-typescript.ts';

/** Parse `source` once and extract symbols/imports/calls for `lang`. */
export function analyze(source: string, lang: Lang = 'python'): Analyzed {
  switch (lang) {
    case 'python':
      return analyzePython(source);
    case 'typescript':
      return analyzeTypescript(source, 'typescript');
    case 'tsx':
      return analyzeTypescript(source, 'tsx');
    case 'go':
      return analyzeGo(source);
    case 'java':
      return analyzeJava(source);
  }
}

export function extractSymbols(source: string): Symbol[] {
  return analyze(source).symbols;
}
