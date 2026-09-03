// command-doctor.ts - pi wiring for the /code command. The only subcommand
// today is `doctor`; anything else prints usage.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { doctor } from "./doctor.ts";

export function registerDoctorCommand(pi: ExtensionAPI): void {
  pi.registerCommand("code", {
    description:
      "/code doctor - codegraph 体检:node/依赖可加载性/索引完整性与语言分布/陈旧度/.gitignore 建议",
    handler: async (args, ctx) => {
      if ((args ?? "").trim() !== "doctor") {
        ctx.ui.notify("用法: /code doctor", "info");
        return;
      }
      ctx.ui.notify(doctor(process.cwd()), "info");
    },
  });
}
