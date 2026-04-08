/**
 * Vela Extension — Entry Point
 *
 * Registers with the Pi SDK platform:
 *   - /vela command (start, status, cancel, help)
 *   - session_start hook (active pipeline awareness + persona injection)
 *   - tool_call hook (mode-based gate enforcement: VK-01 through VK-08)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@mariozechner/pi-coding-agent";

interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerVelaCommands } from "./commands.js";
import { checkToolCall } from "./guards.js";
import {
  findActivePipelineState,
  getCurrentMode,
  loadPipelineDefinition,
} from "./pipeline.js";

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

export default async function registerExtension(
  pi: ExtensionAPI
): Promise<void> {
  // ── /vela command ──────────────────────────────────────────────────────────
  registerVelaCommands(pi);

  // ── session_start: surface active pipeline info ────────────────────────────
  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      const state = findActivePipelineState(ctx.cwd);
      if (state) {
        // Inline box helpers (commands.ts helpers not exported)
        const W = 52;
        const top = (title: string) => {
          const dashes = "─".repeat(Math.max(0, W - 4 - title.length - 1));
          return `╭─ ${title} ${dashes}╮`;
        };
        const line = (content: string) => {
          const inner = W - 4;
          const c = content.length > inner ? content.slice(0, inner - 1) + "…" : content;
          return `│  ${c.padEnd(inner)}│`;
        };
        const bot = (note: string) => {
          const dashes = "─".repeat(Math.max(0, W - 4 - note.length - 1));
          return `╰─ ${note} ${dashes}╯`;
        };

        const stepInfo = state.current_step_index !== undefined
          ? `${state.current_step}  (${state.current_step_index + 1}/${(state.steps ?? []).length})`
          : state.current_step;

        ctx.ui.notify(
          [
            top("⛵  VELA — Active Pipeline"),
            line(`${"Course:".padEnd(9)} ${state.request}`),
            line(`${"Heading:".padEnd(9)} ${stepInfo}`),
            line(`${"Type:".padEnd(9)} ${state.task_type ?? state.pipeline_type}`),
            bot("/vela status for nav chart"),
          ].join("\n"),
          "info"
        );
      }

      // ── Explorer Mode injection (default: always on) ──────────────────────
      const explorerStatePath = join(ctx.cwd, ".vela", "state", "explorer.json");
      let explorerEnabled = true;
      if (existsSync(explorerStatePath)) {
        try {
          explorerEnabled = (JSON.parse(readFileSync(explorerStatePath, "utf8")) as { enabled?: boolean }).enabled ?? true;
        } catch { /* default to enabled */ }
      }
      if (explorerEnabled) {
        ctx.ui.setStatus("vela-explorer", "🔍 explorer");
        await (ctx as unknown as { appendSystemPrompt?: (p: string) => Promise<void> }).appendSystemPrompt?.(EXPLORER_MODE_PROMPT);
      }

      // Surface persona status if .vela/persona.md exists
      const personaPath = join(ctx.cwd, ".vela", "persona.md");
      if (existsSync(personaPath)) {
        try {
          const persona = readFileSync(personaPath, "utf8").trim();
          if (persona && persona.length > 0) {
            ctx.ui.setStatus("vela-persona", "⛵ persona");
            // append to system prompt if api available
            await (ctx as unknown as { appendSystemPrompt?: (p: string) => Promise<void> }).appendSystemPrompt?.(persona);
          }
        } catch {
          // non-fatal
        }
      }
    }
  );

  // ── tool_call: enforce mode-based gates ───────────────────────────────────
  pi.on(
    "tool_call",
    async (
      event: ToolCallEvent,
      ctx: ExtensionContext
    ): Promise<ToolCallEventResult | void> => {
      const state = findActivePipelineState(ctx.cwd);
      if (!state) return; // no active pipeline → pass through

      const def = loadPipelineDefinition(ctx.cwd);
      const mode = getCurrentMode(state, def);

      const result = checkToolCall(
        event.toolName,
        event.input as Record<string, unknown>,
        mode,
        state,
        ctx.cwd,
        def
      );

      if (result.blocked) {
        return {
          block: true,
          reason: result.reason ?? "Blocked by Vela gate",
        };
      }
    }
  );
}
