/**
 * Vela Mode Helpers
 *
 * Manages the pipeline/explorer mode state in .vela/state/mode.json.
 * Also provides the updateVelaStatus utility for refreshing status bar items.
 *
 * Extracted into its own module to avoid circular dependency between
 * index.ts (extension entry point) and commands.ts (command handlers).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { findActivePipelineState } from "./pipeline.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VelaMode = "explorer" | "pipeline";

// ─── Mode State Persistence ───────────────────────────────────────────────────

/** Read the persisted VELA mode from .vela/state/mode.json. Defaults to "explorer". */
export function readVelaMode(cwd: string): VelaMode {
  const modePath = join(cwd, ".vela", "state", "mode.json");
  if (existsSync(modePath)) {
    try {
      const data = JSON.parse(readFileSync(modePath, "utf8")) as { mode?: string };
      if (data.mode === "pipeline" || data.mode === "explorer") return data.mode;
    } catch { /* fall through to default */ }
  }
  return "explorer";
}

/** Write the VELA mode to .vela/state/mode.json atomically. */
export function writeVelaMode(cwd: string, mode: VelaMode): void {
  const stateDir = join(cwd, ".vela", "state");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const modePath = join(stateDir, "mode.json");
  const tmp = modePath + ".tmp";
  writeFileSync(tmp, JSON.stringify({ mode, updated_at: new Date().toISOString() }, null, 2));
  try {
    renameSync(tmp, modePath);
  } catch {
    writeFileSync(modePath, JSON.stringify({ mode, updated_at: new Date().toISOString() }, null, 2));
  }
}

// ─── Status Bar Updater ───────────────────────────────────────────────────────

/**
 * Update all VELA status bar items from current state.
 * Call this on session_start and after any mode/pipeline/auto change.
 *
 * Sets:
 *   vela-mode    — 🚀 pipeline | 🔍 explorer
 *   vela-step    — step progress when pipeline active
 *   vela-auto    — ⚡ auto when auto mode on
 *   vela-sprint  — 🏃 sprint:done/total when sprint active
 */
export function updateVelaStatus(ctx: ExtensionContext, cwd: string): void {
  // Mode indicator
  const mode = readVelaMode(cwd);
  ctx.ui.setStatus("vela-mode", mode === "pipeline" ? "🚀 pipeline" : "🔍 explorer");

  // Active pipeline step
  const state = findActivePipelineState(cwd);
  if (state && state.status === "active") {
    const stepIdx = (state.current_step_index ?? 0) + 1;
    const total = (state.steps ?? []).length;
    ctx.ui.setStatus("vela-step", `${stepIdx}/${total} ${state.current_step}`);
    ctx.ui.setStatus("vela-auto", state.auto ? "⚡ auto" : "");
  } else {
    ctx.ui.setStatus("vela-step", "");
    ctx.ui.setStatus("vela-auto", "");
  }

  // Active sprint
  const sprintLabel = readActiveSprintLabel(cwd);
  ctx.ui.setStatus("vela-sprint", sprintLabel ?? "");
}

/** Read active sprint progress for the status bar. Returns a short label or null. */
export function readActiveSprintLabel(cwd: string): string | null {
  try {
    const sprintsDir = join(cwd, ".vela", "sprints");
    if (!existsSync(sprintsDir)) return null;

    const entries = readdirSync(sprintsDir).filter((f) => f.startsWith("sprint-") && f.endsWith(".json"));
    if (entries.length === 0) return null;

    // Find most-recent running sprint by mtime
    let latestMtime = 0;
    let latestPath = "";
    for (const entry of entries) {
      const p = join(sprintsDir, entry);
      try {
        const m = statSync(p).mtimeMs;
        if (m > latestMtime) { latestMtime = m; latestPath = p; }
      } catch { /* skip */ }
    }
    if (!latestPath) return null;

    const data = JSON.parse(readFileSync(latestPath, "utf8")) as {
      status?: string;
      completed_slices?: number;
      total_slices?: number;
    };
    if (data.status !== "running") return null;
    return `🏃 sprint:${data.completed_slices ?? 0}/${data.total_slices ?? "?"}`;
  } catch {
    return null;
  }
}
