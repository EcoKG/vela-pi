/**
 * Vela Extension — Entry Point
 *
 * Registers with the Pi SDK platform:
 *   - /vela command (start, status, cancel, help)
 *   - session_start hook (active pipeline awareness + persona injection)
 *   - tool_call hook (mode-based gate enforcement: VK-01 through VK-08)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerVelaCommands } from "./commands.js";
import { checkToolCall } from "./guards.js";
import { findActivePipelineState, getCurrentMode, loadPipelineDefinition, } from "./pipeline.js";
export default async function registerExtension(pi) {
    // ── /vela command ──────────────────────────────────────────────────────────
    registerVelaCommands(pi);
    // ── session_start: surface active pipeline info ────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        const state = findActivePipelineState(ctx.cwd);
        if (state) {
            ctx.ui.notify(`[Vela] Active pipeline detected at step "${state.current_step}" ` +
                `(${state.task_type}: "${state.request.slice(0, 60)}...").\n` +
                "Use /vela status for details.", "info");
        }
        // Surface persona status if .vela/persona.md exists
        const personaPath = join(ctx.cwd, ".vela", "persona.md");
        if (existsSync(personaPath)) {
            try {
                const persona = readFileSync(personaPath, "utf8").trim();
                if (persona && persona.length > 0) {
                    ctx.ui.setStatus("vela-persona", "⛵ persona");
                    // append to system prompt if api available
                    await ctx.appendSystemPrompt?.(persona);
                }
            }
            catch {
                // non-fatal
            }
        }
    });
    // ── tool_call: enforce mode-based gates ───────────────────────────────────
    pi.on("tool_call", async (event, ctx) => {
        const state = findActivePipelineState(ctx.cwd);
        if (!state)
            return; // no active pipeline → pass through
        const def = loadPipelineDefinition(ctx.cwd);
        const mode = getCurrentMode(state, def);
        const result = checkToolCall(event.toolName, event.input, mode, state, ctx.cwd);
        if (result.blocked) {
            return {
                block: true,
                reason: result.reason ?? "Blocked by Vela gate",
            };
        }
    });
}
//# sourceMappingURL=index.js.map