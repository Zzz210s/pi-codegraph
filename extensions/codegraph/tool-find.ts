// tool-find.ts - pi wiring for the code_find tool. Thin registration layer;
// query logic lives in find.ts, shared helpers in pi-shared.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { codeFind } from "./find.ts";
import { DEFAULT_TOP_K } from "./pi-shared.ts";
import { textResult } from "./pi-shared.ts";

export function registerFindTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_find",
    label: "代码符号查找",
    description:
      "Find function/class/method definitions by name in the tree-sitter symbol index of a repository " +
      "(Python, TypeScript/TSX, Go, Java). " +
      "Returns ranked rows `file:line kind name signature` (exact > prefix > substring; within a tier " +
      "files sort by PageRank centrality, so generic names surface hub files first). " +
      "The index lives in <root>/.codegraph/index.sqlite; if it is missing, run the /reindex command first.",
    promptGuidelines: [
      "Use code_find when locating a function/class definition instead of grep.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or fragment to search for" }),
      root: Type.Optional(
        Type.String({ description: "Repository root; defaults to the current working directory" })
      ),
      top_k: Type.Optional(
        Type.Number({ description: "Max results to return (default 20)" })
      ),
    }),
    async execute(_id, p, _sig, _onUpdate, _ctx) {
      const root = p.root ?? process.cwd();
      // Clamp instead of rejecting: a bad top_k should not fail the whole call.
      const top_k =
        typeof p.top_k === "number" && Number.isFinite(p.top_k)
          ? Math.max(1, Math.floor(p.top_k))
          : DEFAULT_TOP_K;
      return textResult(codeFind(root, p.query, { top_k }));
    },
  });
}
