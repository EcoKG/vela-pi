/**
 * Vela Pipeline State — Full State Machine
 *
 * Ports vela-engine.js read + write logic:
 *   - State location / loading
 *   - Step resolution & exit-gate checking
 *   - Transition, record, sub-transition
 *   - Git state snapshot + branch/commit helpers
 *   - Artifact cleanup
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFileSync, execSync } from "node:child_process";

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROTECTED_BRANCHES = ["main", "master", "develop"];

// ─── Types ────────────────────────────────────────────────────────────────────

export type PipelineMode = "read" | "write" | "readwrite" | "rw-artifact";

export interface PipelineStep {
  id: string;
  name: string;
  actor: "pm" | "agent" | "user";
  mode: PipelineMode;
  entry_gate: string[];
  exit_gate: string[];
  artifacts: string[];
  max_revisions: number;
  skip_when?: string[];
  sub_phases?: string[];
  sub_phase_tracking?: boolean;
  team?: { worker_role?: string; reviewer_role?: string; approver?: string };
  git?: Record<string, unknown>;
}

export interface PipelineDef {
  version: string;
  pipelines: Record<
    string,
    {
      description: string;
      steps: PipelineStep[];
      inherits?: string;
      steps_only?: string[];
      overrides?: Record<string, Partial<PipelineStep>>;
    }
  >;
  modes: Record<
    string,
    {
      allowed_tools: string[];
      blocked_tools: string[];
      bash_policy: string;
      treenode_cache?: boolean;
      artifact_write_only?: boolean;
    }
  >;
  git?: { commit?: { type_map?: Record<string, string> }; gitignore_entries?: string[] };
}

export interface GitState {
  is_repo: boolean;
  current_branch?: string;
  is_clean?: boolean;
  dirty_files?: number;
  head_hash?: string;
  remote?: string | null;
  is_protected?: boolean;
  stash_ref?: string | null;
  error?: string;
}

export interface SubPhaseState {
  phases: string[];
  current_index: number;
  current_phase: string;
  completed_phases: string[];
}

export interface PipelineState {
  // identity
  pipeline_id?: string;
  pipeline_type: string;
  version?: string;
  // status
  status: "active" | "completed" | "cancelled" | "failed";
  current_step: string;
  current_step_index?: number;
  // request
  request: string;
  task_type?: string;
  type?: string;
  scale?: string;
  // steps
  steps?: string[];
  completed_steps?: string[];
  revisions?: Record<string, number>;
  // git
  git?: {
    is_repo?: boolean;
    base_branch?: string;
    current_branch?: string;
    pipeline_branch?: string | null;
    checkpoint_hash?: string;
    commit_hash?: string | null;
    stash_ref?: string | null;
    remote?: string | null;
  };
  baseline_sha?: string | null;
  // artifact
  artifact_dir: string;
  // auto mode
  auto?: boolean;
  auto_reject_count?: number;
  // sub-phase tracking
  sub_phases?: Record<string, SubPhaseState>;
  sub_phase?: string;
  // timestamps
  created_at: string;
  updated_at: string;
  // runtime-only (not persisted)
  _path?: string;
  _artifactDir?: string;
  _stale?: boolean;
}

export interface ExitGateResult {
  passed: boolean;
  missing: string[];
}

export interface TransitionResult {
  ok: boolean;
  completed?: boolean;
  previous_step?: string;
  current_step?: string;
  current_step_name?: string;
  current_mode?: string;
  error?: string;
  missing?: string[];
}

export interface RecordResult {
  ok: boolean;
  step?: string;
  verdict?: string;
  revision?: number;
  auto_disabled?: boolean;
  error?: string;
}

// ─── State Location ───────────────────────────────────────────────────────────

/**
 * Scan .vela/artifacts/ for the most-recent active pipeline-state.json.
 * Populates _path and _artifactDir runtime fields.
 */
export function findActivePipelineState(cwd: string): PipelineState | null {
  try {
    const artifactsDir = join(cwd, ".vela", "artifacts");
    if (!existsSync(artifactsDir)) return null;

    const dirs = readdirSync(artifactsDir)
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();

    for (const dir of dirs) {
      const dirPath = join(artifactsDir, dir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const statePath = join(dirPath, "pipeline-state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as PipelineState;
        if (state.status === "completed" || state.status === "cancelled") continue;
        state._path = statePath;
        state._artifactDir = dirPath;
        const mtime = statSync(statePath).mtimeMs;
        if (Date.now() - mtime > 24 * 60 * 60 * 1000) state._stale = true;
        return state;
      } catch {
        // corrupt — skip
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Pipeline Definition ──────────────────────────────────────────────────────

export function loadPipelineDefinition(
  cwd: string,
  extensionDir?: string
): PipelineDef | null {
  const candidates = [
    join(cwd, ".vela", "templates", "pipeline.json"),
    ...(extensionDir ? [join(extensionDir, "templates", "pipeline.json")] : []),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as PipelineDef;
    } catch {
      // malformed — try next
    }
  }
  return null;
}

// ─── Step Resolution ──────────────────────────────────────────────────────────

export function resolveSteps(def: PipelineDef, pipelineType: string): PipelineStep[] {
  const pipeline = def.pipelines[pipelineType ?? "standard"];
  if (!pipeline) return [];

  let steps: PipelineStep[] = pipeline.steps;

  // Handle inheritance (e.g. docs pipeline inherits standard)
  if (pipeline.inherits && pipeline.steps_only) {
    const parent = def.pipelines[pipeline.inherits];
    if (parent) {
      steps = parent.steps.filter((s) => pipeline.steps_only!.includes(s.id));
      if (pipeline.overrides) {
        steps = steps.map((s) =>
          pipeline.overrides![s.id] ? { ...s, ...pipeline.overrides![s.id] } : s
        );
      }
    }
  }

  return steps;
}

export function getCurrentStep(
  state: PipelineState,
  def: PipelineDef
): PipelineStep | null {
  const steps = resolveSteps(def, state.pipeline_type);
  return steps.find((s) => s.id === state.current_step) ?? null;
}

export function getCurrentMode(
  state: PipelineState | null,
  def: PipelineDef | null
): PipelineMode {
  if (!state || !def) return "readwrite";
  const step = getCurrentStep(state, def);
  return (step?.mode as PipelineMode) ?? "readwrite";
}

// ─── Exit Gate ────────────────────────────────────────────────────────────────

export function checkExitGate(
  stepDef: PipelineStep,
  state: PipelineState
): ExitGateResult {
  if (!stepDef.exit_gate || stepDef.exit_gate.length === 0) {
    return { passed: true, missing: [] };
  }

  const artifactDir = state._artifactDir ?? state.artifact_dir;
  const missing: string[] = [];
  const completedSteps = state.completed_steps ?? [];
  const revisions = state.revisions ?? {};

  for (const gate of stepDef.exit_gate) {
    switch (gate) {
      case "artifact_dir_created":
        if (!artifactDir || !existsSync(artifactDir)) missing.push(gate);
        break;

      case "mode_detected":
      case "git_clean":
        // Always passes after init
        break;

      case "init_complete":
        if (!completedSteps.includes("init")) missing.push(gate);
        break;

      case "research_md_exists":
        if (!artifactDir || !existsSync(join(artifactDir, "research.md")))
          missing.push(gate);
        break;

      case "plan_md_exists":
        if (!artifactDir || !existsSync(join(artifactDir, "plan.md")))
          missing.push(gate);
        break;

      case "plan_check_pass":
        if (!artifactDir || !existsSync(join(artifactDir, "plan-check.md")))
          missing.push(gate);
        break;

      case "user_approved":
        if (
          state.current_step === "checkpoint" &&
          (!revisions["checkpoint"] || revisions["checkpoint"] < 1)
        ) {
          // Auto mode: plan-check.md present → auto-pass
          if (
            state.auto === true &&
            artifactDir &&
            existsSync(join(artifactDir, "plan-check.md"))
          ) {
            break;
          }
          missing.push(gate);
        }
        break;

      case "plan_architecture_complete":
        if (artifactDir && existsSync(join(artifactDir, "plan.md"))) {
          const planContent = readFileSync(join(artifactDir, "plan.md"), "utf8");
          const required = ["## Architecture", "## Class Specification", "## Test Strategy"];
          for (const section of required) {
            if (!planContent.includes(section)) {
              missing.push(`plan_missing_section:${section}`);
            } else {
              const idx = planContent.indexOf(section);
              const nextIdx = planContent.indexOf("\n## ", idx + section.length);
              const body =
                nextIdx > 0
                  ? planContent.substring(idx + section.length, nextIdx)
                  : planContent.substring(idx + section.length);
              if (body.trim().length < 200) {
                missing.push(`plan_section_too_short:${section}`);
              }
            }
          }
        }
        break;

      case "approval_exists":
      case "leader_approved": {
        if (artifactDir) {
          const approvalPath = join(artifactDir, `approval-${state.current_step}.json`);
          if (!existsSync(approvalPath)) {
            missing.push(`approval_missing:approval-${state.current_step}.json`);
          } else {
            try {
              const approval = JSON.parse(readFileSync(approvalPath, "utf8")) as { decision?: string };
              if (approval.decision !== "approve")
                missing.push(`rejected:${state.current_step}`);
            } catch {
              missing.push(`approval_invalid:${state.current_step}`);
            }
          }
        }
        break;
      }

      case "review_exists":
      case "leader_review_exists": {
        if (artifactDir) {
          const reviewPath = join(artifactDir, `review-${state.current_step}.md`);
          if (!existsSync(reviewPath))
            missing.push(`review_missing:review-${state.current_step}.md`);
        }
        break;
      }

      case "implementation_complete": {
        if (artifactDir) {
          const execApproval = join(artifactDir, "approval-execute.json");
          if (!existsSync(execApproval)) {
            missing.push("approval_missing:approval-execute.json");
          } else {
            try {
              const a = JSON.parse(readFileSync(execApproval, "utf8")) as { decision?: string };
              if (a.decision !== "approve") missing.push("rejected:execute");
            } catch {
              missing.push("approval_invalid:execute");
            }
          }
        }
        break;
      }

      case "branch_created":
        if (state.git?.is_repo) {
          if (!state.git.pipeline_branch && state.current_step === "branch") {
            if (!revisions["branch"] || revisions["branch"] < 1) missing.push(gate);
          }
        }
        break;

      case "changes_committed":
        if (state.git?.is_repo) {
          if (!state.git.commit_hash && state.current_step === "commit") {
            if (!revisions["commit"] || revisions["commit"] < 1) missing.push(gate);
          }
        }
        break;

      case "verification_md_exists":
        if (
          !artifactDir ||
          (!existsSync(join(artifactDir, "verification.md")) &&
            !existsSync(join(artifactDir, "verify.md")))
        )
          missing.push(gate);
        break;

      case "diff_summary_exists":
        if (!artifactDir || !existsSync(join(artifactDir, "diff-summary.md")))
          missing.push(gate);
        break;

      case "learning_md_exists":
        if (!artifactDir || !existsSync(join(artifactDir, "learning.md")))
          missing.push(gate);
        break;

      case "report_md_exists":
        // Finalize gate — report is the output of this step; always passes
        break;

      case "ref_integrity": {
        // Simple reference integrity: check if diff.patch exists and parse it
        // If no git repo, skip gracefully
        const diffPath = join(state._artifactDir ?? state.artifact_dir, "diff.patch");
        if (!existsSync(diffPath)) break; // non-fatal if no diff yet

        try {
          const patch = readFileSync(diffPath, "utf8");
          // Check for obvious broken references: renamed exports without import updates
          const removedExports = [...patch.matchAll(/^-export\s+(?:const|function|class|type|interface)\s+(\w+)/gm)]
            .map(m => m[1]);
          const addedExports = [...patch.matchAll(/^\+export\s+(?:const|function|class|type|interface)\s+(\w+)/gm)]
            .map(m => m[1]);

          // Exports that were removed but not re-added = potential broken refs
          const brokenRefs = removedExports.filter(name => !addedExports.includes(name));
          if (brokenRefs.length > 0) {
            missing.push(...brokenRefs.map(n => `removed export: ${n}`));
          }
        } catch {
          // non-fatal on parse error
        }
        break;
      }

      default:
        // Unknown gate — skip
        break;
    }
  }

  return { passed: missing.length === 0, missing };
}

// ─── State Transitions ────────────────────────────────────────────────────────

/** Advance the pipeline to the next step (mutates + persists state). */
export function transitionPipeline(
  state: PipelineState,
  def: PipelineDef
): TransitionResult {
  const steps = resolveSteps(def, state.pipeline_type);
  const currentIdx = steps.findIndex((s) => s.id === state.current_step);

  if (currentIdx < 0) {
    return { ok: false, error: `Current step "${state.current_step}" not found in pipeline.` };
  }

  const currentStepDef = steps[currentIdx];
  const gateResult = checkExitGate(currentStepDef, state);
  if (!gateResult.passed) {
    return {
      ok: false,
      error: `Exit gate not met for step "${state.current_step}"`,
      missing: gateResult.missing,
    };
  }

  const completedSteps = state.completed_steps ?? [];
  if (!completedSteps.includes(state.current_step)) {
    completedSteps.push(state.current_step);
  }
  state.completed_steps = completedSteps;

  // Last step
  if (currentIdx >= steps.length - 1) {
    state.status = "completed";
    state.current_step = "done";
    state.updated_at = new Date().toISOString();
    persistState(state);
    return { ok: true, completed: true };
  }

  const nextStep = steps[currentIdx + 1];
  state.current_step = nextStep.id;
  state.current_step_index = currentIdx + 1;
  state.updated_at = new Date().toISOString();

  // Initialize sub-phase tracking if applicable
  if (nextStep.sub_phases && nextStep.sub_phase_tracking) {
    if (!state.sub_phases) state.sub_phases = {};
    state.sub_phases[nextStep.id] = {
      phases: nextStep.sub_phases,
      current_index: 0,
      current_phase: nextStep.sub_phases[0],
      completed_phases: [],
    };
  }

  persistState(state);

  // Trace the transition
  const traceArtifactDir = state._artifactDir ?? state.artifact_dir;
  if (traceArtifactDir) {
    appendTrace(traceArtifactDir, {
      event: "transition",
      from: currentStepDef.id,
      to: nextStep.id,
    });
  }

  // Clean up stale delegation.json on transition
  const cwd = deriveCwd(state);
  if (cwd) {
    const delPath = join(cwd, ".vela", "state", "delegation.json");
    try {
      if (existsSync(delPath)) unlinkSync(delPath);
    } catch {
      // non-fatal
    }
  }

  return {
    ok: true,
    completed: false,
    previous_step: currentStepDef.id,
    current_step: nextStep.id,
    current_step_name: nextStep.name,
    current_mode: nextStep.mode,
  };
}

/** Record a step verdict (pass/fail/reject). Increments revision counter. */
export function recordStep(
  state: PipelineState,
  verdict: string,
  summary?: string
): RecordResult {
  const v = verdict.toLowerCase();
  if (!["pass", "fail", "reject"].includes(v)) {
    return { ok: false, error: "Verdict must be: pass, fail, or reject" };
  }

  const revisions = state.revisions ?? {};
  revisions[state.current_step] = (revisions[state.current_step] ?? 0) + 1;
  state.revisions = revisions;

  // Auto mode reject tracking
  if (state.auto === true) {
    if (v === "reject" || v === "fail") {
      state.auto_reject_count = (state.auto_reject_count ?? 0) + 1;
      if (state.auto_reject_count >= 2) state.auto = false;
    } else if (v === "pass") {
      state.auto_reject_count = 0;
    }
  }

  state.updated_at = new Date().toISOString();
  persistState(state);

  // Trace the recorded verdict
  const recordArtifactDir = state._artifactDir ?? state.artifact_dir;
  if (recordArtifactDir) {
    appendTrace(recordArtifactDir, {
      event: "record",
      step: state.current_step,
      verdict: v,
      revision: revisions[state.current_step],
    });
  }

  const autoDisabled =
    state.auto === false && (state.auto_reject_count ?? 0) >= 2 && (v === "reject" || v === "fail");

  return {
    ok: true,
    step: state.current_step,
    verdict: v,
    revision: revisions[state.current_step],
    ...(autoDisabled ? { auto_disabled: true } : {}),
  };
}

/** Advance the TDD sub-phase for the current step. */
export function subTransitionPipeline(
  state: PipelineState
): { ok: boolean; completed?: boolean; previous_phase?: string; current_phase?: string; remaining?: string[]; error?: string } {
  const sp = state.sub_phases?.[state.current_step];
  if (!sp) {
    return { ok: false, error: `Step "${state.current_step}" does not have sub-phase tracking.` };
  }

  if (sp.current_index >= sp.phases.length - 1) {
    return { ok: true, completed: true };
  }

  if (!sp.completed_phases.includes(sp.current_phase)) {
    sp.completed_phases.push(sp.current_phase);
  }

  const previousPhase = sp.current_phase;
  sp.current_index++;
  sp.current_phase = sp.phases[sp.current_index];

  state.updated_at = new Date().toISOString();
  persistState(state);

  return {
    ok: true,
    completed: false,
    previous_phase: previousPhase,
    current_phase: sp.current_phase,
    remaining: sp.phases.slice(sp.current_index + 1),
  };
}

// ─── Git Helpers ──────────────────────────────────────────────────────────────

export function snapshotGitState(cwd: string): GitState {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "pipe" });
  } catch {
    return { is_repo: false };
  }

  try {
    const currentBranch = gitExec(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();
    // -uno: exclude untracked files (they shouldn't block pipeline init)
    const statusOut = gitExec(cwd, "status", "--porcelain", "-uno").trim();
    const headHash = gitExec(cwd, "rev-parse", "HEAD").trim();

    let remote: string | null = null;
    try {
      remote = gitExec(cwd, "remote").trim().split("\n")[0] ?? null;
    } catch {
      // no remote
    }

    return {
      is_repo: true,
      current_branch: currentBranch,
      is_clean: statusOut === "",
      dirty_files: statusOut ? statusOut.split("\n").length : 0,
      head_hash: headHash,
      remote,
      is_protected: PROTECTED_BRANCHES.includes(currentBranch),
    };
  } catch (e) {
    return { is_repo: true, error: (e as Error).message };
  }
}

/** Create (or reuse) a pipeline feature branch. Returns { ok, branch, action, error? }. */
export function createPipelineBranch(
  cwd: string,
  state: PipelineState,
  mode: "auto" | "prompt" | "none" = "auto"
): { ok: boolean; action: string; branch?: string; suggested_command?: string; error?: string } {
  if (!state.git?.is_repo) {
    return { ok: true, action: "skipped", branch: undefined };
  }

  let currentBranch: string;
  try {
    currentBranch = gitExec(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();
  } catch (e) {
    return { ok: false, action: "error", error: (e as Error).message };
  }

  // Already on a non-protected branch
  if (!PROTECTED_BRANCHES.includes(currentBranch)) {
    state.git!.pipeline_branch = currentBranch;
    state.git!.current_branch = currentBranch;
    state.updated_at = new Date().toISOString();
    persistState(state);
    return { ok: true, action: "existing", branch: currentBranch };
  }

  const slug = slugify(state.request);
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const branchName = `vela/${slug}-${timeStr}`;

  if (mode === "none") {
    state.git!.pipeline_branch = currentBranch;
    state.updated_at = new Date().toISOString();
    persistState(state);
    return { ok: true, action: "none", branch: currentBranch };
  }

  if (mode === "prompt") {
    return {
      ok: true,
      action: "prompt",
      branch: branchName,
      suggested_command: `git checkout -b ${branchName}`,
    };
  }

  // Auto: create branch
  try {
    gitExec(cwd, "checkout", "-b", branchName);
  } catch {
    try {
      gitExec(cwd, "checkout", branchName);
    } catch (e2) {
      return { ok: false, action: "error", error: (e2 as Error).message };
    }
  }

  const checkpointHash = gitExec(cwd, "rev-parse", "HEAD").trim();
  state.git!.pipeline_branch = branchName;
  state.git!.current_branch = branchName;
  state.git!.checkpoint_hash = checkpointHash;
  state.updated_at = new Date().toISOString();
  persistState(state);

  return { ok: true, action: "created", branch: branchName };
}

/** Stage and commit all changes. Returns { ok, hash, commit_message, action, error? }. */
export function commitPipeline(
  cwd: string,
  state: PipelineState,
  def: PipelineDef | null,
  messageOverride?: string
): { ok: boolean; action?: string; hash?: string; commit_message?: string; error?: string } {
  if (!state.git?.is_repo) {
    return { ok: true, action: "skipped" };
  }

  const statusOut = gitExec(cwd, "status", "--porcelain").trim();
  if (!statusOut) {
    const hash = gitExec(cwd, "rev-parse", "HEAD").trim();
    if (state.git) state.git.commit_hash = hash;
    state.updated_at = new Date().toISOString();
    persistState(state);
    return { ok: true, action: "no_changes", hash };
  }

  const typeMap: Record<string, string> =
    (def?.git?.commit?.type_map) ?? { code: "feat", "code-bug": "fix", "code-refactor": "refactor", docs: "docs", infra: "chore" };

  const taskType = state.task_type ?? state.type ?? "code";
  const commitType = typeMap[taskType] ?? "feat";
  const shortDesc = state.request.substring(0, 70);
  const commitMessage = messageOverride ?? `${commitType}: ${shortDesc}`;

  // Capture diff as artifact
  try {
    const diff = gitExec(cwd, "diff", "HEAD");
    const artifactDir = state._artifactDir ?? state.artifact_dir;
    if (diff && artifactDir) {
      writeFileSync(join(artifactDir, "diff.patch"), diff);
    }
  } catch {
    // non-fatal
  }

  // Stage all, then unstage .vela/ internals
  try {
    gitExec(cwd, "add", "-A");
    const velaInternals = [".vela/cache/", ".vela/state/", ".vela/artifacts/", ".vela/tracker-signals.json", ".vela/write-log.jsonl"];
    for (const vf of velaInternals) {
      try { gitExec(cwd, "reset", "HEAD", "--", vf); } catch { /* skip */ }
    }
  } catch (e) {
    return { ok: false, error: `Failed to stage: ${(e as Error).message}` };
  }

  try {
    gitExec(cwd, "commit", "-m", commitMessage);
  } catch (e) {
    return { ok: false, error: `Commit failed: ${(e as Error).message}` };
  }

  const commitHash = gitExec(cwd, "rev-parse", "HEAD").trim();
  if (state.git) state.git.commit_hash = commitHash;
  state.updated_at = new Date().toISOString();
  persistState(state);

  return { ok: true, action: "committed", hash: commitHash, commit_message: commitMessage };
}

// ─── Pipeline History ─────────────────────────────────────────────────────────

export interface PipelineHistoryEntry {
  date: string;
  slug: string;
  status: string;
  type: string;
  request: string;
  step: string;
  steps_completed: number;
  steps_total: number;
  created: string;
  updated: string;
}

export function listPipelineHistory(cwd: string): PipelineHistoryEntry[] {
  const artifactsDir = join(cwd, ".vela", "artifacts");
  if (!existsSync(artifactsDir)) return [];

  const result: PipelineHistoryEntry[] = [];
  try {
    const allDirs = readdirSync(artifactsDir)
      .filter((d) => /^\d{8}T\d{6}-/.test(d))
      .sort()
      .reverse();

    for (const dir of allDirs) {
      const dirPath = join(artifactsDir, dir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const statePath = join(dirPath, "pipeline-state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as PipelineState;
        result.push({
          date: dir.slice(0, 8),
          slug: dir,
          status: state.status,
          type: state.pipeline_type,
          request: (state.request ?? "").substring(0, 60),
          step: state.current_step,
          steps_completed: (state.completed_steps ?? []).length,
          steps_total: (state.steps ?? []).length,
          created: state.created_at,
          updated: state.updated_at,
        });
      } catch {
        // skip corrupt
      }
    }
  } catch {
    // non-fatal
  }
  return result;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/** Remove cancelled/completed artifact dirs older than `hoursOld` hours. */
export function cleanupCancelledArtifacts(cwd: string, hoursOld = 24): number {
  const artifactsDir = join(cwd, ".vela", "artifacts");
  if (!existsSync(artifactsDir)) return 0;

  const cutoff = Date.now() - hoursOld * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    for (const dir of readdirSync(artifactsDir).filter((d) => /^\d{8}T\d{6}-/.test(d))) {
      const dirPath = join(artifactsDir, dir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const statePath = join(dirPath, "pipeline-state.json");
      if (!existsSync(statePath)) {
        try {
          if (readdirSync(dirPath).length === 0) { rmSync(dirPath); cleaned++; }
        } catch { /* skip */ }
        continue;
      }
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as PipelineState;
        if (state.status !== "cancelled" && state.status !== "completed") continue;
        if (statSync(statePath).mtimeMs > cutoff) continue;
        rmSync(dirPath, { recursive: true, force: true });
        cleaned++;
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }

  return cleaned;
}

/**
 * Mark pipelines that have been active for more than 48h as cancelled.
 * Returns the number of pipelines marked as stale.
 */
export function cleanupStalePipelines(cwd: string, hoursOld = 48): number {
  const artifactsDir = join(cwd, ".vela", "artifacts");
  if (!existsSync(artifactsDir)) return 0;

  let count = 0;
  try {
    const entries = readdirSync(artifactsDir);
    const cutoff = Date.now() - hoursOld * 60 * 60 * 1000;

    for (const entry of entries) {
      const statePath = join(artifactsDir, entry, "pipeline-state.json");
      if (!existsSync(statePath)) continue;
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as PipelineState;
        if (raw.status !== "active") continue;

        const updatedAt = new Date(raw.updated_at).getTime();
        if (isNaN(updatedAt) || updatedAt > cutoff) continue;

        // Mark as cancelled
        raw.status = "cancelled";
        raw.updated_at = new Date().toISOString();
        writeFileSync(statePath, JSON.stringify(raw, null, 2), "utf8");
        count++;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return count;
}

// ─── Trace Logging ────────────────────────────────────────────────────────────

/** Append a JSON line to trace.jsonl in the artifact directory. Non-fatal. */
function appendTrace(artifactDir: string, entry: Record<string, unknown>): void {
  try {
    const tracePath = join(artifactDir, "trace.jsonl");
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(tracePath, line, "utf8");
  } catch { /* non-fatal */ }
}

// ─── State Writing ────────────────────────────────────────────────────────────

/** Atomic JSON write via tmp → rename. */
export function writeJSON(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

function persistState(state: PipelineState): void {
  if (!state._path) return;
  const clean = { ...state };
  delete clean._path;
  delete clean._artifactDir;
  delete clean._stale;
  writeJSON(state._path, clean);
}

// ─── Utility Helpers ─────────────────────────────────────────────────────────

/** Generate a URL-safe slug from a string (max 40 chars). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Format a Date as YYYYMMDDTHHMMSS. */
export function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function gitExec(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).toString();
}

function deriveCwd(state: PipelineState): string | null {
  const artifactDir = state._artifactDir ?? state.artifact_dir;
  if (!artifactDir) return null;
  // .vela/artifacts/{slug} → project root is 3 levels up
  return dirname(dirname(dirname(artifactDir)));
}

export { execSync };
