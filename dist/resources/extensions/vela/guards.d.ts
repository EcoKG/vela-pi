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
 *
 * Tool permission lists (blocked_tools, artifact_write_only) and bash_policy
 * are read from pipeline.json `modes.*` at runtime — pipeline.json is the
 * single source of truth.  Hardcoded constants are kept only as fallbacks
 * for callers that do not supply a PipelineDef.
 */
import type { PipelineMode, PipelineState, PipelineDef } from "./pipeline.js";
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
 * Derive the set of write-capable tools from pipeline.json.
 * "Write-capable" = tools blocked in read mode (modes.read.blocked_tools).
 * Falls back to the hardcoded WRITE_TOOLS constant when no def is supplied.
 */
export declare function getEffectiveWriteTools(def?: PipelineDef | null): Set<string>;
/**
 * Evaluate all applicable gate rules for a tool call.
 *
 * Returns { blocked: false } to allow, or { blocked: true, reason, code } to deny.
 * Implements VK-01 through VK-08 (mode-based) and VG-00 through VG-12 (pipeline-state-based).
 *
 * Tool permission decisions (blocked_tools, artifact_write_only, bash_policy) are
 * derived from pipelineDef.modes[mode] when provided — pipeline.json is the single
 * source of truth.  All checks fall back to hardcoded constants when pipelineDef
 * is absent, preserving full backward compatibility.
 *
 * @param state       - Full pipeline state for VG-series gate checks (optional; VK-only if absent)
 * @param cwd         - Project working directory for delegation.json lookup (optional)
 * @param pipelineDef - Loaded pipeline.json definition; drives data-driven mode enforcement
 */
export declare function checkToolCall(toolName: string, toolInput: Record<string, unknown>, mode: PipelineMode, state?: PipelineState | null, cwd?: string, pipelineDef?: PipelineDef | null): GuardResult;
//# sourceMappingURL=guards.d.ts.map