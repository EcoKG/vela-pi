/**
 * Vela Extension — Entry Point
 *
 * Registers with the Pi SDK platform:
 *   - /vela command (start, status, cancel, help)
 *   - session_start hook (active pipeline awareness + persona injection)
 *   - tool_call hook (mode-based gate enforcement: VK-01 through VK-08)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function registerExtension(pi: ExtensionAPI): Promise<void>;
//# sourceMappingURL=index.d.ts.map