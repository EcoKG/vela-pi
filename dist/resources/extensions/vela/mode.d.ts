/**
 * Vela Mode Helpers
 *
 * Manages the pipeline/explorer mode state in .vela/state/mode.json.
 * Also provides the updateVelaStatus utility for refreshing status bar items.
 *
 * Extracted into its own module to avoid circular dependency between
 * index.ts (extension entry point) and commands.ts (command handlers).
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
export type VelaMode = "explorer" | "pipeline";
/** Read the persisted VELA mode from .vela/state/mode.json. Defaults to "explorer". */
export declare function readVelaMode(cwd: string): VelaMode;
/** Write the VELA mode to .vela/state/mode.json atomically. */
export declare function writeVelaMode(cwd: string, mode: VelaMode): void;
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
export declare function updateVelaStatus(ctx: ExtensionContext, cwd: string): void;
/** Read active sprint progress for the status bar. Returns a short label or null. */
export declare function readActiveSprintLabel(cwd: string): string | null;
//# sourceMappingURL=mode.d.ts.map