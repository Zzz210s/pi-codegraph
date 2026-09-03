// parse-typescript.ts - tree-sitter TypeScript/TSX single-walk analysis.
// Pure module: no fs, no store. Semantics mirror parse-python.ts:
// - symbols: class/function/method definitions plus named arrow functions
//   (const f = (...) => ...); export wrappers are transparent.
// - imports: import sources with quotes stripped, document order, deduped.
// - calls: attributed to the innermost enclosing function body only; the
//   callee keeps its last identifier segment (obj.method -> 'method');
//   require()/import() excluded. new-expressions create no call edge.
import Parser from 'tree-sitter';
import TSPkg from 'tree-sitter-typescript';
import type { Analyzed, DefNode } from './parse.ts';
import type { Symbol } from './store.ts';

const parsers: Record<string, Parser> = {
  typescript: new Parser(),
  tsx: new Parser(),
};
parsers.typescript.setLanguage(TSPkg.typescript as never);
parsers.tsx.setLanguage(TSPkg.tsx as never);

const CALLEE_EXCLUDE = new Set(['require', 'import']);

// Last identifier segment of a call callee: identifier -> its text;
// member_expression -> the property's text; anything else -> null.
function tsCalleeName(callNode: DefNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

export function analyzeTypescript(
  source: string,
  variant: 'typescript' | 'tsx' = 'typescript'
): Analyzed {
  const tree = parsers[variant].parse(source);
  const root = tree.rootNode as unknown as DefNode;

  const symbols: Symbol[] = [];
  const imports: string[] = [];
  const calls: { caller: string; callee: string }[] = [];
  const seenImports = new Set<string>();
  const seenCalls = new Set<string>();

  const fnOrder: DefNode[] = [];
  const fnNames = new Map<DefNode, string>();
  const fnCalls = new Map<DefNode, string[]>();

  function pushSymbol(nameNode: DefNode, kind: Symbol['kind'], defNode: DefNode): void {
    symbols.push({
      name: nameNode.text,
      kind,
      line: defNode.startPosition.row + 1,
      signature: defNode.text.split('\n', 1)[0].trim(),
    });
  }

  function walk(node: DefNode, curFn: DefNode | null): void {
    const type = node.type;

    if (type === 'import_statement') {
      const src = node.childForFieldName('source');
      const ref = src ? src.text.replace(/^['"]|['"]$/g, '') : null;
      if (ref !== null && !seenImports.has(ref)) {
        seenImports.add(ref);
        imports.push(ref);
      }
      return;
    }
    if (type === 'export_statement') {
      // export is a transparent wrapper around the real declaration
      for (const child of node.namedChildren) walk(child, curFn);
      return;
    }
    if (type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) pushSymbol(nameNode, 'class', node);
      for (const child of node.namedChildren) walk(child, null);
      return;
    }
    if (type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) {
        for (const child of node.namedChildren) walk(child, curFn);
        return;
      }
      pushSymbol(nameNode, 'function', node);
      fnOrder.push(node);
      fnNames.set(node, nameNode.text);
      const body = node.childForFieldName('body');
      for (const child of node.namedChildren) walk(child, child === body ? node : null);
      return;
    }
    if (type === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        pushSymbol(nameNode, 'method', node);
        fnOrder.push(node);
        fnNames.set(node, nameNode.text);
        const body = node.childForFieldName('body');
        for (const child of node.namedChildren) walk(child, child === body ? node : null);
      }
      return;
    }
    if (type === 'variable_declarator') {
      // const f = (x) => ...  -> named arrow function owned by f's body
      const nameNode = node.childForFieldName('name');
      const value = node.childForFieldName('value');
      if (nameNode && nameNode.type === 'identifier' && value && value.type === 'arrow_function') {
        pushSymbol(nameNode, 'function', node);
        fnOrder.push(value);
        fnNames.set(value, nameNode.text);
        const body = value.childForFieldName('body');
        for (const child of value.namedChildren) walk(child, child === body ? value : null);
        return;
      }
      for (const child of node.namedChildren) walk(child, curFn);
      return;
    }
    if (type === 'call_expression' && curFn !== null) {
      const calleeName = tsCalleeName(node);
      if (calleeName !== null && !CALLEE_EXCLUDE.has(calleeName)) {
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
      for (const child of node.namedChildren) walk(child, curFn);
      return;
    }
    for (const child of node.namedChildren) walk(child, curFn);
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
