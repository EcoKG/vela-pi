/**
 * Vela Extension — Entry Point
 *
 * Registers with the Pi SDK platform:
 *   - /vela command (start, status, cancel, help, mode, ...)
 *   - session_start hook (active pipeline awareness + persona injection + status bar)
 *   - tool_call hook (mode-based gate enforcement: VK-01 through VK-08)
 *
 * Status bar items set via ctx.ui.setStatus:
 *   vela-mode    — 🚀 pipeline | 🔍 explorer
 *   vela-step    — step progress when pipeline active (3/12 execute)
 *   vela-auto    — ⚡ auto when auto mode on
 *   vela-sprint  — 🏃 sprint:2/5 when sprint active
 *   vela-persona — ⛵ persona when persona file present
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerVelaCommands } from "./commands.js";
import { checkToolCall } from "./guards.js";
import { findActivePipelineState, getCurrentMode, loadPipelineDefinition, cleanupStalePipelines, } from "./pipeline.js";
import { readVelaMode, writeVelaMode, updateVelaStatus, readActiveSprintLabel, } from "./mode.js";
// Re-export for consumers (commands.ts, etc.)
export { readVelaMode, writeVelaMode, updateVelaStatus };
// ─── Explorer Mode Prompt ─────────────────────────────────────────────────────
const EXPLORER_MODE_PROMPT = `
# VELA Explorer Mode — Active

You are operating in **Vela Explorer Mode**. This enforces fact-check-first answering.

## Core Rules
1. **Verify before claiming**: Before stating that a file, function, class, or pattern exists, use Read/Grep/Glob to confirm it.
2. **Cite every code claim**: Format citations as \`[path/to/file.ts:line]\`. If you cannot cite it, you have not verified it.
3. **Distinguish fact from inference**: Use "I verified in [file]..." for confirmed facts, "I infer that..." for unverified reasoning.
4. **No assumed structure**: Do not guess directory layouts or import trees — use Glob to enumerate, then Read to confirm.
5. **Analysis = tools first, synthesis second**: Run searches before summarising. Never summarise from memory alone.

## In Practice
- Asked about code: Read the actual file. Then answer.
- Making architecture claims: Grep for the patterns first.
- Uncertain about a path: Glob it. If not found, say so.
`.trim();
const PIPELINE_MODE_PROMPT = `
# VELA Pipeline Mode — Active

You are operating in **Vela Pipeline Mode**. Focus on executing the current pipeline step precisely.

## Core Rules
1. **Follow the pipeline**: Check current step with \`/vela status\` and follow it exactly.
2. **Use pipeline commands**: Use \`/vela dispatch\`, \`/vela transition\`, \`/vela record\` for all pipeline actions.
3. **Step-scoped work**: Only work on what the current step requires — no scope creep.
4. **Document progress**: Write artifacts to the pipeline artifact directory as required by each step.
5. **Gate compliance**: Ensure exit gates are met before transitioning.

## Quick Reference
- \`/vela status\`             — current step and progress
- \`/vela dispatch\`           — run agent for current step
- \`/vela transition\`         — advance to next step
- \`/vela record pass|fail\`   — record step verdict
- \`/vela mode explorer\`      — switch to explorer mode
`.trim();
// ─── Extension Registration ───────────────────────────────────────────────────
export default async function registerExtension(pi) {
    // ── /vela command ──────────────────────────────────────────────────────────
    registerVelaCommands(pi);
    // ── Shift+Tab key handler (defensive — only if SDK supports key events) ───
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pi.on?.("keypress", async (key, ctx) => {
            // Shift+Tab = ESC [ Z
            if (key === "\x1b[Z") {
                const cwd = ctx.cwd;
                const current = readVelaMode(cwd);
                const next = current === "explorer" ? "pipeline" : "explorer";
                writeVelaMode(cwd, next);
                updateVelaStatus(ctx, cwd);
                const label = next === "pipeline" ? "🚀 Pipeline Mode" : "🔍 Explorer Mode";
                ctx.ui.notify(`⛵ VELA  ·  Mode → ${label}  (Shift+Tab to switch)`, "info");
            }
        });
    }
    catch { /* SDK does not support key events — use /vela mode instead */ }
    // ── session_start: status bar + pipeline awareness + mode restore ──────────
    pi.on("session_start", async (_event, ctx) => {
        const cwd = ctx.cwd;
        // Auto-cleanup stale pipelines on session start (improvement #13)
        cleanupStalePipelines(cwd);
        // Read persisted mode (improvement #15)
        const mode = readVelaMode(cwd);
        // Update all status bar items (improvements #2–6)
        updateVelaStatus(ctx, cwd);
        // ── Active pipeline banner ──────────────────────────────────────────
        const state = findActivePipelineState(cwd);
        if (state) {
            const W = 52;
            const top = (title) => {
                const dashes = "─".repeat(Math.max(0, W - 4 - title.length - 1));
                return `╭─ ${title} ${dashes}╮`;
            };
            const line = (content) => {
                const inner = W - 4;
                const c = content.length > inner ? content.slice(0, inner - 1) + "…" : content;
                return `│  ${c.padEnd(inner)}│`;
            };
            const bot = (note) => {
                const dashes = "─".repeat(Math.max(0, W - 4 - note.length - 1));
                return `╰─ ${note} ${dashes}╯`;
            };
            const stepIdx = (state.current_step_index ?? 0) + 1;
            const total = (state.steps ?? []).length;
            const stepInfo = `${state.current_step}  (${stepIdx}/${total})`;
            const autoNote = state.auto ? "  ⚡ auto" : "";
            const staleNote = state._stale ? "  ⚠ stale (>48h)" : "";
            const notifyLines = [
                top("⛵  VELA — Active Pipeline"),
                line(`${"Course:".padEnd(9)} ${state.request}`),
                line(`${"Heading:".padEnd(9)} ${stepInfo}${autoNote}${staleNote}`),
                line(`${"Type:".padEnd(9)} ${state.task_type ?? state.pipeline_type}`),
                line(`${"Mode:".padEnd(9)} ${mode === "pipeline" ? "🚀 pipeline" : "🔍 explorer"}`),
            ];
            // Show sprint status if active (improvement #16)
            const sprintLine = readActiveSprintLabel(cwd);
            if (sprintLine) {
                notifyLines.push(line(`${"Sprint:".padEnd(9)} ${sprintLine}`));
            }
            notifyLines.push(bot("/vela status  ·  Shift+Tab to switch mode"));
            ctx.ui.notify(notifyLines.join("\n"), "info");
        }
        // ── Mode system prompt injection ────────────────────────────────────
        const explorerStatePath = join(cwd, ".vela", "state", "explorer.json");
        let explorerEnabled = mode === "explorer"; // default from mode file
        // Back-compat: if explorer.json exists, honour it
        if (existsSync(explorerStatePath)) {
            try {
                explorerEnabled = JSON.parse(readFileSync(explorerStatePath, "utf8")).enabled ?? true;
            }
            catch { /* default */ }
        }
        if (mode === "explorer" && explorerEnabled) {
            ctx.ui.setStatus("vela-explorer", "🔍 explorer");
            await ctx.appendSystemPrompt?.(EXPLORER_MODE_PROMPT);
        }
        else if (mode === "pipeline") {
            ctx.ui.setStatus("vela-explorer", "");
            await ctx.appendSystemPrompt?.(PIPELINE_MODE_PROMPT);
        }
        // ── Persona injection ───────────────────────────────────────────────
        const personaPath = join(cwd, ".vela", "persona.md");
        if (existsSync(personaPath)) {
            try {
                const persona = readFileSync(personaPath, "utf8").trim();
                if (persona.length > 0) {
                    ctx.ui.setStatus("vela-persona", "⛵ persona");
                    await ctx.appendSystemPrompt?.(persona);
                }
            }
            catch { /* non-fatal */ }
        }
    });
    // ── tool_call: enforce mode-based gates ───────────────────────────────────
    pi.on("tool_call", async (event, ctx) => {
        const state = findActivePipelineState(ctx.cwd);
        if (!state)
            return;
        const def = loadPipelineDefinition(ctx.cwd);
        const mode = getCurrentMode(state, def);
        const result = checkToolCall(event.toolName, event.input, mode, state, ctx.cwd, def);
        if (result.blocked) {
            return {
                block: true,
                reason: result.reason ?? "Blocked by Vela gate",
            };
        }
    });
}
//# sourceMappingURL=index.js.map