// tool-trace.ts - pi wiring for the code_trace tool. Thin registration layer;
// traversal logic lives in graph.ts, shared helpers in pi-shared.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { traceCallees, traceCallers } from "./graph.ts";
import { missingIndexHint, openIndexStore, resolveDepth, textResult } from "./pi-shared.ts";

export function registerTraceTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_trace",
    label: "代码调用追溯",
    description:
      "Trace who calls a symbol (direction callers) or what a symbol calls (direction callees) " +
      "using the tree-sitter call/import graph. " +
      "Returns one line per node: `depth  via  file  symbol` (symbol omitted on import edges). " +
      "The index lives in <root>/.codegraph/index.sqlite; if it is missing, run the /reindex command first.",
    promptGuidelines: [
      "Use code_trace when the agent needs to know who calls a symbol or what a symbol calls.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to trace" }),
      direction: Type.Union([
        Type.Literal("callers", { description: "Who calls this symbol (upward)" }),
        Type.Literal("callees", { description: "What this symbol calls (downward)" }),
      ]),
      depth: Type.Optional(
        Type.Number({ description: "Traversal depth, clamped to 1-5 (default 2)" })
      ),
      root: Type.Optional(
        Type.String({ description: "Repository root; defaults to the current working directory" })
      ),
    }),
    async execute(_id, p, _sig, _onUpdate, _ctx) {
      const root = p.root ?? process.cwd();
      const depth = resolveDepth(p.depth);
      let store: ReturnType<typeof openIndexStore>;
      try {
        store = openIndexStore(root);
      } catch (e) {
        return textResult((e as Error).message); // friendly corrupt-db hint
      }
      if (store === null) return textResult(missingIndexHint(root));
      try {
        const nodes =
          p.direction === "callees"
            ? traceCallees(store, p.symbol, depth)
            : traceCallers(store, p.symbol, depth);
        if (nodes.length === 0) {
          return textResult(
            `未找到 "${p.symbol}" 的调用关系。建议先用 code_find 确认符号名,或检查是否已 /reindex。`
          );
        }
        const lines = nodes.map((n) =>
          n.symbol === null
            ? `${n.depth}  ${n.via}  ${n.file}`
            : `${n.depth}  ${n.via}  ${n.file}  ${n.symbol}`
        );
        return textResult(lines.join("\n"));
      } finally {
        store.close();
      }
    },
  });
}
