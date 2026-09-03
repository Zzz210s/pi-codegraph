// command-reindex.ts - pi wiring for the /reindex command. Thin registration
// layer; indexing logic lives in indexer.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { indexRepo } from "./indexer.ts";

export function registerReindexCommand(pi: ExtensionAPI): void {
  pi.registerCommand("reindex", {
    description:
      "重建 codegraph 符号索引:扫描仓库源码文件,增量解析后写入 .codegraph/index.sqlite。参数可选,为仓库根路径,默认当前工作目录",
    handler: async (args, ctx) => {
      const root = (args ?? "").trim() || process.cwd();
      const r = indexRepo(root);
      ctx.ui.notify(
        `索引完成: ${r.files} 文件, ${r.symbols} 符号, ${r.ms} ms。索引库在 .codegraph/ (建议加入 .gitignore)`,
        "info"
      );
    },
  });
}
