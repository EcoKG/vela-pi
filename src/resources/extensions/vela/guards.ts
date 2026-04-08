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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineMode, PipelineState, PipelineDef } from "./pipeline.js";

// ─── Guard Patterns (ported from constants.js) ────────────────────────────────

/** Bash commands safe in read-only mode */
export const SAFE_BASH_READ =
  /^\s*(ls|cat|head|tail|find|grep|rg|wc|file|stat|tree|pwd|echo|which|node\s+.*--version|python3?\s+--version|git\s+(status|log|diff|branch|show|blame|remote|ls-files|ls-tree|rev-parse|describe|tag|config\s+--get)|(npm|yarn|pnpm)\s+(run\s+)?(test|build|lint|check|typecheck)|npx\s+(jest|vitest|eslint|prettier|tsc)|cargo\s+(test|build|check|clippy|fmt)|go\s+(test|build|vet)|pytest|python3?\s+-m\s+(pytest|unittest)|tsc|make|dotnet\s+(test|build))\b/;

/** Bash patterns that write to the filesystem */
export const BASH_WRITE_PATTERNS: RegExp[] = [
  /(?<![0-9&])>\s*(?!&)/, // redirect to file (not 2>&1)
  /\|\s*tee\s/, // pipe to tee
  /\bcp\s/, // copy
  /\bmv\s/, // move
  /\brm\s/, // remove
  /\bmkdir\s/, // create dir
  /\btouch\s/, // create file
  /\bsed\s+-i/, // sed in-place
  /\bchmod\s/, // change permissions
  /\bchown\s/, // change ownership
  /\bgit\s+(add|commit|push|merge|rebase|reset|checkout|stash)/,
  /\bnpm\s+(install|uninstall|update|publish)/,
  /\byarn\s+(add|remove|install)/,
  /\bpip\s+(install|uninstall)/,
];

/** Chain operators that allow bash injection even in safe commands */
export const CHAIN_OPERATOR_RE = /&&|\|\||;|\|/;

/** Secret patterns — block writes containing these (VK-06) */
export const SECRET_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[A-Z0-9]{16}/, // AWS access key
  /ghp_[A-Za-z0-9_]{36}/, // GitHub PAT
  /gho_[A-Za-z0-9_]{36}/, // GitHub OAuth
  /sk-[A-Za-z0-9]{48}/, // OpenAI key
  /sk-ant-[A-Za-z0-9-]{90,}/, // Anthropic key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /sk_live_[A-Za-z0-9]{24,}/, // Stripe live key
  /rk_live_[A-Za-z0-9]{24,}/, // Stripe restricted key
  /mongodb\+srv:\/\/[^:]+:[^@]+@/, // MongoDB connection
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/, // PostgreSQL connection
  /mysql:\/\/[^:]+:[^@]+@/, // MySQL connection
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, // Private key
  /xox[bpsar]-[A-Za-z0-9-]{10,}/, // Slack token
  /AIza[A-Za-z0-9_-]{35}/, // Google API key
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/, // SendGrid key
];

/** Sensitive files that should never be written (VK-05) */
export const SENSITIVE_FILES: string[] = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
];

/**
 * Hardcoded fallback: tools that can write files.
 * Used when no PipelineDef is supplied. The canonical list lives in
 * pipeline.json → modes.read.blocked_tools.
 */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// ─── Guard Result ─────────────────────────────────────────────────────────────

export interface GuardResult {
  blocked: boolean;
  reason?: string;
  code?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the set of write-capable tools from pipeline.json.
 * "Write-capable" = tools blocked in read mode (modes.read.blocked_tools).
 * Falls back to the hardcoded WRITE_TOOLS constant when no def is supplied.
 */
export function getEffectiveWriteTools(def?: PipelineDef | null): Set<string> {
  const readBlocked = def?.modes["read"]?.blocked_tools;
  return readBlocked ? new Set(readBlocked) : WRITE_TOOLS;
}

// ─── Main Guard Function ──────────────────────────────────────────────────────

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
export function checkToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  mode: PipelineMode,
  state?: PipelineState | null,
  cwd?: string,
  pipelineDef?: PipelineDef | null
): GuardResult {
  // Resolve effective write tools and current mode definition once
  const effectiveWriteTools = getEffectiveWriteTools(pipelineDef);
  const modeDef = pipelineDef?.modes[mode];

  // ── VK-01 / VK-02: Bash enforcement ──────────────────────────────────────
  if (toolName === "Bash") {
    const cmd =
      typeof toolInput.command === "string" ? toolInput.command : "";

    // VK-06: Secret detection in Bash commands (all modes)
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(cmd)) {
        return { blocked: true, reason: `[Vela VK-06] Potential secret detected in Bash command. Blocked.`, code: "VK-06" };
      }
    }

    // Resolve bash_policy from pipeline.json; fall back to mode-derived defaults.
    // In restricted (readwrite) mode, Bash is not blocked at VK level — it falls
    // through to VG pipeline-state checks so VG-07 / VG-08 / VG-DESTROY / VG-14
    // remain enforced in readwrite mode.
    const bashPolicy =
      modeDef?.bash_policy ??
      (mode === "write" ? "blocked" : mode === "readwrite" ? "restricted" : "read_only");

    if (bashPolicy !== "restricted") {
      // VK-08: Chain operators — block unless ALL segments are safe-read
      if (CHAIN_OPERATOR_RE.test(cmd)) {
        const segments = cmd.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
        const allSegmentsSafe = segments.every(seg => SAFE_BASH_READ.test(seg));
        if (!allSegmentsSafe) {
          return {
            blocked: true,
            reason: `[Vela VK-08] Bash chain operator blocked: not all segments are safe-read commands.\n` +
              `  Unsafe segments: ${segments.filter(s => !SAFE_BASH_READ.test(s)).map(s => s.substring(0, 50)).join(", ")}\n` +
              `  Tip: Run each command separately, or ensure all parts are read-only.`,
            code: "VK-08",
          };
        }
        // All segments safe — allow the chain
      }

      if (bashPolicy === "blocked") {
        return {
          blocked: true,
          reason: `[Vela VK-01] Bash is blocked in ${mode} mode. Use Write/Edit tools.`,
          code: "VK-01",
        };
      }

      // read_only: write patterns checked BEFORE safe-read allowlist so that
      // commands like "echo hello > file.txt" are never let through.
      for (const pattern of BASH_WRITE_PATTERNS) {
        if (pattern.test(cmd)) {
          return {
            blocked: true,
            reason: `[Vela VK-01] Bash write command blocked in ${mode} mode: ${cmd.slice(0, 80)}`,
            code: "VK-01",
          };
        }
      }
      if (SAFE_BASH_READ.test(cmd)) return { blocked: false };
      return {
        blocked: true,
        reason: `[Vela VK-02] Bash command not in safe-read allowlist (mode: ${mode}). Use Read/Glob/Grep instead.`,
        code: "VK-02",
      };
    }
    // restricted: falls through to VG pipeline-state checks at end of function
  }

  // ── VK-03 / VK-04: Write-tool enforcement (data-driven from pipeline.json) ──
  // Fallback blocked-tools map mirrors pipeline.json defaults for when no def is supplied.
  const DEFAULT_BLOCKED: Partial<Record<string, string[]>> = {
    "read":        ["Edit", "Write", "NotebookEdit"],
    "rw-artifact": ["Edit", "NotebookEdit"],
  };

  if (effectiveWriteTools.has(toolName)) {
    // VK-03: tool appears in blocked_tools for this mode (read → all write tools)
    const readBlocked = modeDef
      ? (mode !== "rw-artifact" && modeDef.blocked_tools.includes(toolName))
      : mode === "read"; // fallback

    if (readBlocked) {
      return {
        blocked: true,
        reason: `[Vela VK-03] ${toolName} blocked in ${mode} mode.`,
        code: "VK-03",
      };
    }

    // VK-04: rw-artifact — Edit/NotebookEdit blocked; Write only inside .vela/artifacts/
    const isRwArtifact = modeDef ? modeDef.artifact_write_only === true : mode === "rw-artifact";

    if (isRwArtifact) {
      const rwArtifactBlocked = modeDef
        ? modeDef.blocked_tools.includes(toolName)
        : (DEFAULT_BLOCKED["rw-artifact"] ?? []).includes(toolName);

      if (rwArtifactBlocked) {
        return {
          blocked: true,
          reason: `[Vela VK-04] ${toolName} is blocked in ${mode} mode. Use Write tool instead.`,
          code: "VK-04",
        };
      }

      const filePath =
        typeof toolInput.file_path === "string"
          ? toolInput.file_path
          : typeof toolInput.path === "string"
            ? toolInput.path
            : "";

      if (filePath && !filePath.includes("/.vela/artifacts/")) {
        return {
          blocked: true,
          reason: `[Vela VK-04] ${toolName} in ${mode} mode may only write inside .vela/artifacts/. Path: ${filePath}`,
          code: "VK-04",
        };
      }
    }

    // ── VK-05: Sensitive file protection ──────────────────────────────────
    const filePath =
      typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : typeof toolInput.path === "string"
          ? toolInput.path
          : "";

    if (filePath) {
      const basename = filePath.split("/").pop() ?? "";
      if (SENSITIVE_FILES.some((sf) => basename === sf || filePath.endsWith("/" + sf))) {
        return {
          blocked: true,
          reason: `[Vela VK-05] Write to sensitive file blocked: ${filePath}`,
          code: "VK-05",
        };
      }
    }

    // ── VK-06: Secret detection ────────────────────────────────────────────
    const content =
      typeof toolInput.content === "string"
        ? toolInput.content
        : typeof toolInput.new_string === "string"
          ? toolInput.new_string
          : "";

    if (content) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          return {
            blocked: true,
            reason: `[Vela VK-06] Potential secret detected in ${toolName} content. Blocked.`,
            code: "VK-06",
          };
        }
      }
    }
  }

  // ── VK-07: PM actor — write tools require delegation.json ────────────────
  if (effectiveWriteTools.has(toolName) && state) {
    const PM_STEPS = new Set(["init", "branch", "commit", "finalize"]);
    if (PM_STEPS.has(state.current_step)) {
      const artifactDir = state._artifactDir ?? state.artifact_dir;
      if (artifactDir) {
        const delegationPath = join(artifactDir, "delegation.json");
        if (!existsSync(delegationPath)) {
          const filePath =
            typeof toolInput.file_path === "string" ? toolInput.file_path :
            typeof toolInput.path === "string" ? toolInput.path : "";
          const isArtifactWrite = filePath.startsWith(artifactDir) ||
                                   filePath.includes("/.vela/");
          if (!isArtifactWrite && filePath) {
            return {
              blocked: true,
              reason: `[Vela VK-07] PM cannot write source files directly without delegation.json.\n` +
                `  File: ${filePath}\n` +
                `  Use /vela dispatch to delegate to an executor agent.`,
              code: "VK-07",
            };
          }
        }
      }
    }
  }

  // ══ VG-SERIES: Pipeline-state-based guards (require state context) ══════════
  if (state) {
    const vgResult = checkGateGuard(toolName, toolInput, state, cwd, effectiveWriteTools);
    if (vgResult.blocked) return vgResult;
  }

  return { blocked: false };
}

// ─── VG-Series Gate Guards ───────────────────────────────────────────────────

/**
 * Pipeline-state-based gate guards (VG-00 through VG-12).
 * These require the full PipelineState to evaluate.
 *
 * @param writeTools - Set of write-capable tool names, derived from pipeline.json
 *                     (defaults to hardcoded WRITE_TOOLS for backward compatibility)
 */
function checkGateGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: PipelineState,
  cwd?: string,
  writeTools: Set<string> = WRITE_TOOLS
): GuardResult {
  const currentStep = state.current_step;
  const completedSteps = state.completed_steps ?? [];

  // ── VG-00: Block task management tools during active pipeline ──────────────
  const BLOCKED_TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TodoWrite"]);
  if (BLOCKED_TASK_TOOLS.has(toolName)) {
    return {
      blocked: true,
      reason: `[Vela VG-00] ${toolName} is blocked during an active pipeline. Use /vela status instead.`,
      code: "VG-00",
    };
  }

  // ── VG-05: pipeline-state.json direct write protection ────────────────────
  if (writeTools.has(toolName)) {
    const filePath =
      typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : typeof toolInput.path === "string"
          ? toolInput.path
          : "";

    if (filePath && filePath.includes("pipeline-state.json")) {
      return {
        blocked: true,
        reason: `[Vela VG-05] Direct writes to pipeline-state.json are blocked. Use /vela transition, /vela record, or /vela cancel.`,
        code: "VG-05",
      };
    }

    // ── VG-02: Source code writes before execute step ────────────────────────
    const PRE_EXECUTE_STEPS = new Set(["init", "research", "plan", "plan-check", "checkpoint", "branch"]);
    if (PRE_EXECUTE_STEPS.has(currentStep) && filePath) {
      const normalized = filePath.replace(/\\/g, "/");
      const isVelaWrite =
        normalized.includes("/.vela/artifacts/") ||
        normalized.includes("/.vela/templates/") ||
        normalized.includes("/.vela/");
      if (!isVelaWrite) {
        return {
          blocked: true,
          reason: `[Vela VG-02] Source code modification blocked in step "${currentStep}". Source writes only allowed from the execute step onward.`,
          code: "VG-02",
        };
      }
    }

    // ── VG-04: report.md requires verification.md ───────────────────────────
    if (filePath && (filePath.endsWith("report.md") || filePath.endsWith("/report.md"))) {
      const artifactDir = state._artifactDir ?? state.artifact_dir;
      if (artifactDir) {
        const verifyExists =
          existsSync(join(artifactDir, "verification.md")) ||
          existsSync(join(artifactDir, "verify.md"));
        if (!verifyExists) {
          return {
            blocked: true,
            reason: `[Vela VG-04] report.md cannot be written before verification.md exists. Complete the verify step first.`,
            code: "VG-04",
          };
        }
      }
    }

    // ── VG-11: approval/review files only in team steps ─────────────────────
    const TEAM_STEPS = new Set([
      "research", "plan", "execute", "diff-summary", "verify",
    ]);
    if (filePath) {
      const basename = filePath.split("/").pop() ?? "";
      if ((/^approval-/.test(basename) || /^review-/.test(basename)) && !TEAM_STEPS.has(currentStep)) {
        return {
          blocked: true,
          reason: `[Vela VG-11] ${basename} can only be written during team steps. Current step "${currentStep}" is not a team step.`,
          code: "VG-11",
        };
      }
    }

    // ── VG-12: execute step — delegation.json must exist and be valid ────────
    if (currentStep === "execute" && cwd && filePath && !filePath.includes("/.vela/")) {
      const artifactDir = state._artifactDir ?? state.artifact_dir;
      const delegationPath = artifactDir
        ? join(artifactDir, "delegation.json")
        : join(cwd, ".vela", "state", "delegation.json");
      if (!existsSync(delegationPath)) {
        return {
          blocked: true,
          reason: `[Vela VG-12] Direct source writes in execute step require delegation.json. ` +
            `Use /vela dispatch to delegate to an executor agent.`,
          code: "VG-12",
        };
      }
      // Validate schema
      try {
        const del = JSON.parse(readFileSync(delegationPath, "utf8")) as Record<string, unknown>;
        if (!del.executor || !del.task) {
          return {
            blocked: true,
            reason: `[Vela VG-12] delegation.json is invalid (missing executor or task fields). Re-run /vela dispatch.`,
            code: "VG-12",
          };
        }
      } catch {
        // non-fatal parse error — allow
      }
    }

    // ── VG-13: artifact path traversal prevention ────────────────────────────
    if (filePath) {
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized.includes("/../") || normalized.endsWith("/..")) {
        return {
          blocked: true,
          reason: `[Vela VG-13] Path traversal detected in file path: ${filePath.substring(0, 80)}`,
          code: "VG-13",
        };
      }
    }
  }

  // ── VG-14: Concurrent pipeline detection ───────────────────────────────────
  if (toolName === "Bash" && cwd) {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    if (/vela[-_]?engine.*init\b/.test(cmd) || /\/vela\s+start\b/.test(cmd)) {
      if (state.status === "active") {
        return {
          blocked: true,
          reason: `[Vela VG-14] Another pipeline is already active at step "${state.current_step}". Cancel it first with /vela cancel.`,
          code: "VG-14",
        };
      }
    }
  }

  // ── VG-15: *.vela-tmp accumulation guard ───────────────────────────────────
  if (writeTools.has(toolName)) {
    const filePath =
      typeof toolInput.file_path === "string" ? toolInput.file_path :
      typeof toolInput.path === "string" ? toolInput.path : "";
    if (filePath && filePath.endsWith(".vela-tmp")) {
      return {
        blocked: true,
        reason: `[Vela VG-15] Direct writes to *.vela-tmp files are blocked. Use pipeline artifact dir instead.`,
        code: "VG-15",
      };
    }
  }

  // ── VG-07/VG-08: Git command step restrictions ────────────────────────────
  if (toolName === "Bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";

    // VG-07: git commit only in execute/commit/finalize
    if (/\bgit\s+commit\b/.test(cmd)) {
      const GIT_COMMIT_STEPS = new Set(["execute", "commit", "finalize"]);
      if (!GIT_COMMIT_STEPS.has(currentStep)) {
        return {
          blocked: true,
          reason: `[Vela VG-07] git commit is only allowed in execute/commit/finalize steps. Current: ${currentStep}.`,
          code: "VG-07",
        };
      }
    }

    // VG-08: git push requires verify step to be completed
    if (/\bgit\s+push\b/.test(cmd)) {
      if (!completedSteps.includes("verify")) {
        return {
          blocked: true,
          reason: `[Vela VG-08] git push is blocked until the verify step is completed.`,
          code: "VG-08",
        };
      }
      // Always block --force
      if (/--force\b|-f\b/.test(cmd)) {
        return {
          blocked: true,
          reason: `[Vela VG-08] git push --force is always blocked during a Vela pipeline.`,
          code: "VG-08",
        };
      }
    }

    // VG-DESTROY: block obviously destructive commands
    if (/\bgit\s+reset\s+--hard\b/.test(cmd)) {
      return {
        blocked: true,
        reason: `[Vela] git reset --hard is blocked during an active pipeline.`,
        code: "VG-DESTROY",
      };
    }
    if (/\brm\s+-rf?\b/.test(cmd) && !cmd.includes(".vela/")) {
      return {
        blocked: true,
        reason: `[Vela] rm -rf is blocked during an active pipeline.`,
        code: "VG-DESTROY",
      };
    }
  }

  return { blocked: false };
}
