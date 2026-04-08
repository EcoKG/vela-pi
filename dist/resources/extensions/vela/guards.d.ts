/**
 * Vela Guards — Tool Call Gate Enforcement
 *
 * TypeScript port of:
 *   - scripts/shared/constants.js   (guard patterns)
 *   - scripts/hooks/vela-gate-keeper.js  (VK-01 through VK-08 rules)
 *   - references/gates-and-guards.md    (VG-00 through VG-12 rules)
 *
 * All logic runs synchronously inside the Pi SDK tool_call event handler,
 * replacing the old Claude Code Hook subprocess with a deterministic function.
 */
import type { PipelineMode, PipelineState } from "./pipeline.js";
/** Bash commands safe in read-only mode */
export declare const SAFE_BASH_READ: RegExp;
/** Bash patterns that write to the filesystem */
export declare const BASH_WRITE_PATTERNS: RegExp[];
/** Chain operators that allow bash injection even in safe commands */
export declare const CHAIN_OPERATOR_RE: RegExp;
/** Secret patterns — block writes containing these (VK-06) */
export declare const SECRET_PATTERNS: RegExp[];
/** Sensitive files that should never be written (VK-05) */
export declare const SENSITIVE_FILES: string[];
export interface GuardResult {
    blocked: boolean;
    reason?: string;
    code?: string;
}
/**
 * Evaluate all applicable gate rules for a tool call.
 *
 * Returns { blocked: false } to allow, or { blocked: true, reason, code } to deny.
 * Implements VK-01 through VK-08 (mode-based) and VG-00 through VG-12 (pipeline-state-based).
 *
 * @param state - Full pipeline state for VG-series gate checks (optional; VK-only if absent)
 * @param cwd   - Project working directory for delegation.json lookup (optional)
 */
export declare function checkToolCall(toolName: string, toolInput: Record<string, unknown>, mode: PipelineMode, state?: PipelineState | null, cwd?: string): GuardResult;
//# sourceMappingURL=guards.d.ts.map