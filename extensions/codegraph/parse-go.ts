// parse-go.ts - tree-sitter Go single-walk analysis.
// Pure module: no fs, no store. Semantics mirror parse-python.ts:
// - symbols: function_declaration ('function'), method_declaration
//   ('method'), type_spec of struct/interface type ('class'); plain type
//   aliases are not symbols.
// - imports: unquoted import spec paths in document order, deduped.
// - calls: attributed to the innermost enclosing function body only; a
//   selector call keeps its last segment (fmt.Println -> 'Println').
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import type { Analyzed, DefNode } from './parse.ts';
import type { Symbol } from './store.ts';

const parser = new Parser();
parser.setLanguage(Go as never);

function goCalleeName(callNode: DefNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    return field ? field.text : null;
  }
  return null;
}

export function analyzeGo(source: string): Analyzed {
  const tree = parser.parse(source);
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

  function collectImportSpec(node: DefNode): void {
    // import_declaration covers both `import "x"` (direct spec) and the
    // grouped form (import_spec_list > import_spec*).
    if (node.type === 'import_spec') {
      const path = node.childForFieldName('path');
      const ref = path ? path.text.replace(/^"|"$/g, '') : null;
      if (ref !== null && !seenImports.has(ref)) {
        seenImports.add(ref);
        imports.push(ref);
      }
      return;
    }
    for (const child of node.namedChildren) collectImportSpec(child);
  }

  function walk(node: DefNode, curFn: DefNode | null): void {
    const type = node.type;

    if (type === 'import_declaration') {
      collectImportSpec(node);
      return;
    }
    if (type === 'type_spec') {
      const nameNode = node.childForFieldName('name');
      const typeNode = node.childForFieldName('type');
      if (
        nameNode &&
        typeNode &&
        (typeNode.type === 'struct_type' || typeNode.type === 'interface_type')
      ) {
        pushSymbol(nameNode, 'class', node);
      }
      return;
    }
    if (type === 'function_declaration' || type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      pushSymbol(nameNode, type === 'method_declaration' ? 'method' : 'function', node);
      fnOrder.push(node);
      fnNames.set(node, nameNode.text);
      const body = node.childForFieldName('body');
      for (const child of node.namedChildren) walk(child, child === body ? node : null);
      return;
    }
    if (type === 'call_expression' && curFn !== null) {
      const calleeName = goCalleeName(node);
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
