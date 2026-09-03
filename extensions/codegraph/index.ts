// index.ts - pi extension entry for codegraph.
// Thin wiring layer: no logic lives here. Every tool/command registration
// lives in its own small module (global rule: code files stay <= 200 lines):
//   tool-find.ts         code_find
//   tool-trace.ts        code_trace
//   tool-impact.ts       code_impact
//   tool-map.ts          code_map
//   command-reindex.ts   /reindex
//   command-doctor.ts    /code doctor
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDoctorCommand } from "./command-doctor.ts";
import { registerReindexCommand } from "./command-reindex.ts";
import { registerFindTool } from "./tool-find.ts";
import { registerImpactTool } from "./tool-impact.ts";
import { registerMapTool } from "./tool-map.ts";
import { registerTraceTool } from "./tool-trace.ts";

export default function (pi: ExtensionAPI) {
  registerFindTool(pi);
  registerTraceTool(pi);
  registerImpactTool(pi);
  registerMapTool(pi);
  registerReindexCommand(pi);
  registerDoctorCommand(pi);
}
