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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readVelaMode, writeVelaMode, updateVelaStatus, type VelaMode } from "./mode.js";
export { readVelaMode, writeVelaMode, updateVelaStatus, type VelaMode };
export default function registerExtension(pi: ExtensionAPI): Promise<void>;
//# sourceMappingURL=index.d.ts.map