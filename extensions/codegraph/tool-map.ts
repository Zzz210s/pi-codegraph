// tool-map.ts - pi wiring for the code_map tool. Thin registration layer;
// map generation lives in map.ts, shared helpers in pi-shared.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { codeMap } from "./map.ts";
import { textResult } from "./pi-shared.ts";

export function registerMapTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_map",
    label: "整仓代码地图",
    description:
      "Generate an aider-style condensed repo map from the tree-sitter index: files ordered by PageRank " +
      "centrality (most central first), each with its key `line kind name signature` symbols, filled " +
      "until a token budget runs out (default 1500, clamped 200..8000). " +
      "Use it to understand a repository's structure and hot spots in one call instead of many greps. " +
      "The index lives in <root>/.codegraph/index.sqlite; if it is missing, run the /reindex command first.",
    promptGuidelines: [
      "Use code_map when the agent needs a structural overview of an unfamiliar repository.",
    ],
    parameters: Type.Object({
      token_budget: Type.Optional(
        Type.Number({ description: "Max output tokens, clamped to 200..8000 (default 1500)" })
      ),
      root: Type.Optional(
        Type.String({ description: "Repository root; defaults to the current working directory" })
      ),
    }),
    async execute(_id, p, _sig, _onUpdate, _ctx) {
      const root = p.root ?? process.cwd();
      const budget =
        typeof p.token_budget === "number" && Number.isFinite(p.token_budget)
          ? p.token_budget
          : undefined;
      return textResult(codeMap(root, { token_budget: budget }));
    },
  });
}
