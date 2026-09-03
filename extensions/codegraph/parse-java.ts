// parse-java.ts - tree-sitter Java single-walk analysis.
// Pure module: no fs, no store. Semantics mirror parse-python.ts:
// - symbols: class/interface/enum/record declarations ('class') and
//   method_declaration ('method'); constructors are not symbols.
// - imports: the dotted scoped name of import statements, document order.
// - calls: attributed to the innermost enclosing method body only;
//   method_invocation uses its name field, object creation keeps the last
//   segment of the type name.
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import type { Analyzed, DefNode } from './parse.ts';
import type { Symbol } from './store.ts';

const parser = new Parser();
parser.setLanguage(Java as never);

const CLASS_NODES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

function lastSegment(text: string): string {
  const parts = text.split('.');
  return parts[parts.length - 1];
}

export function analyzeJava(source: string): Analyzed {
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

  function walk(node: DefNode, curFn: DefNode | null): void {
    const type = node.type;

    if (type === 'import_declaration') {
      for (const child of node.namedChildren) {
        if (child.type === 'scoped_identifier') {
          const ref = child.text;
          if (!seenImports.has(ref)) {
            seenImports.add(ref);
            imports.push(ref);
          }
        }
      }
      return;
    }
    if (CLASS_NODES.has(type)) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) pushSymbol(nameNode, 'class', node);
      for (const child of node.namedChildren) walk(child, null);
      return;
    }
    if (type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      pushSymbol(nameNode, 'method', node);
      fnOrder.push(node);
      fnNames.set(node, nameNode.text);
      const body = node.childForFieldName('body');
      for (const child of node.namedChildren) walk(child, child === body ? node : null);
      return;
    }
    if (type === 'method_invocation' || type === 'object_creation_expression') {
      // callee name: method name field, or the created type's last segment
      let calleeName: string | null = null;
      if (type === 'method_invocation') {
        const nameNode = node.childForFieldName('name');
        calleeName = nameNode ? nameNode.text : null;
      } else {
        const typeNode = node.childForFieldName('type');
        calleeName = typeNode ? lastSegment(typeNode.text) : null;
      }
      if (calleeName !== null && curFn !== null) {
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
