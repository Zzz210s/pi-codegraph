// parse-python.ts - tree-sitter Python parse: single-walk analysis of one
// source file. Pure module: no fs, no store, no pi runtime dependency.
//
//   analyzePython(source)  one parse -> { symbols, imports, calls }
//
// Semantics (preserved from the original parse.ts):
// - imports are collected anywhere in the tree in document order, deduped by
//   ref text (a repeated ref always resolves identically within one file).
// - symbols are collected in tree order for every definition with a name.
// - call sites are attributed to the innermost enclosing function body only;
//   module level, class bodies and function signatures are never candidates.
// - call dedupe key is caller+callee; edges are emitted per enclosing
//   function in tree order.
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { DefNode } from './parse.ts';
import type { Analyzed } from './parse.ts';
import type { Symbol } from './store.ts';

const parser = new Parser();
parser.setLanguage(Python);

/** A function is a 'method' when it sits directly inside a class body,
 * possibly wrapped in a decorated_definition. Anything else is 'function'. */
function functionKind(fn: DefNode): 'function' | 'method' {
  let parent: DefNode | null = fn.parent;
  if (parent && parent.type === 'decorated_definition') parent = parent.parent;
  return parent !== null &&
    parent.type === 'block' &&
    parent.parent !== null &&
    parent.type === 'block' &&
    parent.parent.type === 'class_definition'
    ? 'method'
    : 'function';
}

// Parse `source` once and extract everything downstream code needs from a
// single pre-order walk over the one tree. See module header for semantics.
export function analyzePython(source: string): Analyzed {
  const tree = parser.parse(source);
  const root = tree.rootNode as unknown as DefNode;

  const symbols: Symbol[] = [];
  const imports: string[] = [];
  const calls: { caller: string; callee: string }[] = [];
  const seenImports = new Set<string>();
  const seenCalls = new Set<string>();

  // Enclosing function_definition nodes in tree order, plus their name text;
  // call sites accumulate per function and are flattened afterwards so the
  // emitted order matches the old per-capture iteration.
  const fnOrder: DefNode[] = [];
  const fnNames = new Map<DefNode, string>();
  const fnCalls = new Map<DefNode, string[]>();

  function collectImportRefs(stmt: DefNode): void {
    let refs: string[] = [];
    if (stmt.type === 'import_statement') {
      refs = stmt.namedChildren
        .map((child) =>
          child.type === 'dotted_name'
            ? child.text
            : child.type === 'aliased_import'
              ? (child.childForFieldName('name')?.text ?? null)
              : null
        )
        .filter((t): t is string => t !== null);
    } else {
      const moduleName = stmt.childForFieldName('module_name');
      const ref = moduleName ? moduleRefText(moduleName) : null;
      refs = ref === null ? [] : [ref];
    }
    for (const ref of refs) {
      if (seenImports.has(ref)) continue;
      seenImports.add(ref);
      imports.push(ref);
    }
  }

  function pushSymbol(def: DefNode): DefNode | null {
    const nameNode = def.childForFieldName('name');
    if (!nameNode) return null;
    symbols.push({
      name: nameNode.text,
      kind: def.type === 'class_definition' ? 'class' : functionKind(def),
      line: def.startPosition.row + 1, // 0-based row -> 1-based line
      // first line of the definition node text (decorator line excluded, since
      // decorators are siblings of the definition node)
      signature: def.text.split('\n', 1)[0].trim(),
    });
    return nameNode;
  }

  // One pre-order walk over the single tree. `curFn` is the innermost
  // function_definition whose body currently contains us; it is null at
  // module level and inside class bodies / function signatures, where the
  // old implementation collected nothing.
  function walk(node: DefNode, curFn: DefNode | null): void {
    const type = node.type;

    if (type === 'import_statement' || type === 'import_from_statement') {
      collectImportRefs(node);
    } else if (type === 'function_definition' || type === 'class_definition') {
      if (type === 'function_definition') {
        const nameNode = pushSymbol(node);
        if (nameNode) {
          fnOrder.push(node);
          fnNames.set(node, nameNode.text);
          const body = node.childForFieldName('body');
          // only the body is owned by this function; parameter/annotation
          // calls stay invisible to call edges (curFn null)
          for (const child of node.namedChildren) walk(child, child === body ? node : null);
        } else {
          // broken/nameless def contributes nothing to symbols or calls
          for (const child of node.namedChildren) walk(child, null);
        }
      } else {
        pushSymbol(node);
        // method bodies push themselves as curFn when visited; calls directly
        // in a class body or base-class list are invisible
        for (const child of node.namedChildren) walk(child, null);
      }
    } else if (type === 'call' && curFn !== null) {
      const calleeName = callCalleeName(node);
      if (calleeName !== null) {
        const key = `${fnNames.get(curFn)}\0${calleeName}`;
        if (!seenCalls.has(key)) {
          seenCalls.add(key);
          let list = fnCalls.get(curFn);
          if (!list) {
            list = [];
            fnCalls.set(curFn, list);
          }
          list.push(calleeName);
        }
      }
      // nested calls inside the arguments still belong to curFn
      for (const child of node.namedChildren) walk(child, curFn);
    } else {
      for (const child of node.namedChildren) walk(child, curFn);
    }
  }

  walk(root, null);

  for (const fn of fnOrder) {
    const list = fnCalls.get(fn);
    if (!list) continue;
    const caller = fnNames.get(fn) ?? '';
    for (const callee of list) calls.push({ caller, callee });
  }

  return { symbols, imports, calls };
}

// Last identifier segment of a call's callee: 'fn' for identifier calls,
// 'method' for attribute calls like 'obj.method()'. Anything else has no
// plain name -> null.
export function callCalleeName(callNode: DefNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr ? attr.text : null;
  }
  return null;
}

// Text of an import_from_statement's module_name: plain dotted_name for
// absolute imports, or dots + dotted part for relative imports ('.mod').
export function moduleRefText(moduleName: DefNode): string | null {
  if (moduleName.type === 'dotted_name') return moduleName.text;
  if (moduleName.type === 'relative_import') {
    const prefix = moduleName.namedChildren.find((c) => c.type === 'import_prefix');
    const dotted = moduleName.namedChildren.find((c) => c.type === 'dotted_name');
    const text = (prefix ? prefix.text : '') + (dotted ? dotted.text : '');
    return text === '' ? null : text;
  }
  return null;
}
