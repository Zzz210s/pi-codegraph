// tool-impact.ts - pi wiring for the code_impact tool. Thin registration
// layer; blast-radius logic lives in graph.ts, helpers in pi-shared.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { blastRadius } from "./graph.ts";
import { isFileTarget, missingIndexHint, openIndexStore, resolveDepth, textResult } from "./pi-shared.ts";

export function registerImpactTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_impact",
    label: "变更影响分析",
    description:
      "Compute the blast radius of changing a target: every file, symbol, and test file that could be affected " +
      "through the call/import graph. target is treated as a file when it ends with .py or contains a path " +
      "separator, otherwise as a symbol. " +
      "Returns a summary line `受影响: 文件 N | 符号 M | 测试 K`, then the affected files, then test files " +
      "under a `测试文件:` header. " +
      "The index lives in <root>/.codegraph/index.sqlite; if it is missing, run the /reindex command first.",
    promptGuidelines: [
      "Use code_impact when a change to a file or symbol might break other code.",
    ],
    parameters: Type.Object({
      target: Type.String({
        description: "File path (ends with .py or contains a path separator) or symbol name",
      }),
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
        const target = isFileTarget(p.target)
          ? { file: p.target }
          : { symbol: p.target };
        const blast = blastRadius(store, target, depth);
        const testSet = new Set(blast.tests);
        const files = blast.files.filter((f) => !testSet.has(f));
        const lines = [
          `受影响: 文件 ${files.length} | 符号 ${blast.symbols.length} | 测试 ${blast.tests.length}`,
        ];
        for (const f of files) lines.push(f);
        if (blast.tests.length > 0) {
          lines.push("测试文件:");
          for (const t of blast.tests) lines.push(`test:${t}`);
        }
        return textResult(lines.join("\n"));
      } finally {
        store.close();
      }
    },
  });
}
