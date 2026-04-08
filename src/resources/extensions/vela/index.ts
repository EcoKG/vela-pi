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
        ctx.cwd
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
