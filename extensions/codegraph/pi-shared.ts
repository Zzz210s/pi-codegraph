// pi-shared.ts - helpers shared by every pi wiring module of codegraph:
// db-missing / corrupt guidance wording, index store opening, numeric
// clamps and the text result shape. No logic beyond defaults lives here.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { openStore } from "./store.ts";
import type { Store } from "./store.ts";

export const DEFAULT_TOP_K = 20;
export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 5;

// Depth binding shared by code_trace and code_impact: default 2, clamp 1..5.
// floor() makes fractional input sane, then the clamp keeps it in range.
export function clampDepth(depth: number): number {
  return Math.min(MAX_DEPTH, Math.max(1, Math.floor(depth)));
}

export function resolveDepth(depth: number | undefined): number {
  return typeof depth === "number" && Number.isFinite(depth)
    ? clampDepth(depth)
    : DEFAULT_DEPTH;
}

// Same db-missing wording as find.ts, with the requested root interpolated.
export function missingIndexHint(root: string): string {
  return `索引不存在,请先运行 /reindex ${root}`;
}

// Open the repo index, or null when it does not exist yet. better-sqlite3
// would create an empty db on open, so the existence check comes first.
export function openIndexStore(root: string): Store | null {
  const dbPath = join(root, ".codegraph", "index.sqlite");
  if (!existsSync(dbPath)) return null;
  return openStore(dbPath);
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// A target is a file when it ends with a known source extension or contains
// a path separator (slash or backslash); otherwise it is a symbol name.
export function isFileTarget(target: string): boolean {
  return (
    target.endsWith(".py") ||
    target.endsWith(".ts") ||
    target.endsWith(".tsx") ||
    target.endsWith(".go") ||
    target.endsWith(".java") ||
    /[\\/]/.test(target)
  );
}
