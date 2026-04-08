/**
 * Vela Slash Commands — Phase 2
 *
 * /vela start "<request>"        — initialise a new pipeline
 * /vela status                   — show current pipeline state
 * /vela transition               — advance to next step
 * /vela record <pass|fail|reject> [--summary TEXT]  — record step verdict
 * /vela sub-transition           — advance TDD sub-phase
 * /vela branch [--mode auto|prompt|none]            — create feature branch
 * /vela commit [--message TEXT]  — commit pipeline changes
 * /vela history                  — list pipeline history
 * /vela auto                     — toggle auto mode
 * /vela cancel                   — cancel the active pipeline
 * /vela help                     — show usage
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { readVelaMode, writeVelaMode, updateVelaStatus, type VelaMode } from "./mode.js";
import {
  cleanupCancelledArtifacts,
  cleanupStalePipelines,
  commitPipeline,
  createPipelineBranch,
  findActivePipelineState,
  formatTimestamp,
  getCurrentMode,
  listPipelineHistory,
  loadPipelineDefinition,
  persistState,
  recordStep,
  resolveSteps,
  slugify,
  snapshotGitState,
  subTransitionPipeline,
  transitionPipeline,
  writeJSON,
  type PipelineState,
} from "./pipeline.js";
import { runVelaAgent, getAvailableRoles, getRoleConfig } from "./dispatch.js";
import {
  createSprint,
  findActiveSprint,
  findResumableSprint,
  listSprints,
  loadSprint,
  updateSliceStatus,
  updateSprintStatus,
  getNextSlice,
  generateSprintSummary,
  buildSliceContext,
  type SprintPlan,
  type SprintSlice,
} from "./sprint.js";

// ─── UI Box Helpers ───────────────────────────────────────────────────────────

const BOX_W = 52; // total box width including border chars

/** ╭─ Title ──────────────╮ */
function boxTop(title = "", w = BOX_W): string {
  const dashes = "─".repeat(Math.max(0, w - 4 - title.length - (title ? 1 : 0)));
  return title ? `╭─ ${title} ${dashes}╮` : `╭${"─".repeat(w - 2)}╮`;
}
/** │  content padded      │ */
function boxLine(content = "", w = BOX_W): string {
  const inner = w - 4;
  // Truncate if content exceeds inner width to keep box aligned
  const c = content.length > inner ? content.slice(0, inner - 1) + "…" : content;
  return `│  ${c.padEnd(inner)}│`;
}
/** ├──────────────────────┤ */
function boxSep(w = BOX_W): string {
  return `├${"─".repeat(w - 2)}┤`;
}
/** ╰─ note ───────────────╯ */
function boxBot(note = "", w = BOX_W): string {
  const dashes = "─".repeat(Math.max(0, w - 4 - note.length - (note ? 1 : 0)));
  return note ? `╰─ ${note} ${dashes}╯` : `╰${"─".repeat(w - 2)}╯`;
}
/** Pad a label to fixed width for aligned key: value rows */
function lbl(label: string, width = 9): string {
  return label.padEnd(width);
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerVelaCommands(pi: ExtensionAPI): void {
  pi.registerCommand("vela", {
    description: "Vela pipeline engine — /vela start|status|transition|record|dispatch|branch|commit|history|auto|mode|explorer|cancel|help",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      switch (sub) {
        case "start":
          await cmdStart(parts.slice(1).join(" "), ctx);
          break;
        case "status":
          await cmdStatus(parts.slice(1), ctx);
          break;
        case "transition":
          await cmdTransition(ctx);
          break;
        case "record":
          await cmdRecord(parts.slice(1), ctx);
          break;
        case "sub-transition":
          await cmdSubTransition(ctx);
          break;
        case "branch":
          await cmdBranch(parts.slice(1), ctx);
          break;
        case "commit":
          await cmdCommit(parts.slice(1), ctx);
          break;
        case "history":
          await cmdHistory(parts.slice(1), ctx);
          break;
        case "dispatch":
          await cmdDispatch(parts.slice(1), ctx);
          break;
        case "sprint":
          await cmdSprint(parts.slice(1), ctx);
          break;
        case "auto":
          await cmdAuto(ctx);
          break;
        case "analyze":
          await cmdAnalyze(parts.slice(1), ctx);
          break;
        case "explorer":
          await cmdExplorer(parts.slice(1), ctx);
          break;
        case "mode":
          await cmdMode(parts.slice(1), ctx);
          break;
        case "cancel":
          await cmdCancel(ctx);
          break;
        default:
          cmdHelp(ctx);
      }
    },
  });
}

// ─── Sub-commands ─────────────────────────────────────────────────────────────

// Scale → pipeline type mapping (mirrors pipeline.json "scales" section)
const SCALE_TO_PIPELINE: Record<string, string> = {
  small:  "trivial",
  medium: "quick",
  large:  "standard",
  ralph:  "ralph",
  hotfix: "hotfix",
};

const SCALE_DESCRIPTIONS: Record<string, string> = {
  small:  "trivial  — init → execute → commit → finalize (4 steps)",
  medium: "quick    — init → plan → execute → verify → commit → finalize (6 steps)",
  large:  "standard — full 12-step pipeline with research, review, diff-summary, learning",
  ralph:  "ralph    — TDD loop: execute ↔ verify up to 10× until tests pass",
  hotfix: "hotfix   — init → execute → commit (docs/config only, no review)",
};

async function cmdStart(
  request: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;

  // Parse --scale and --preset flags from args
  const argTokens = request.split(/\s+/);
  const scaleIdx = argTokens.indexOf("--scale");
  const presetIdx = argTokens.indexOf("--preset");

  let rawScale = scaleIdx >= 0 ? argTokens[scaleIdx + 1] : undefined;
  const presetName = presetIdx >= 0 ? argTokens[presetIdx + 1] : undefined;

  // Remove flags from request text
  const cleanRequest = argTokens
    .filter((t, i) =>
      t !== "--scale" && t !== "--preset" && t !== "--force" &&
      i !== scaleIdx + 1 && i !== presetIdx + 1
    )
    .join(" ")
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!cleanRequest) {
    ctx.ui.notify(
      'Usage: /vela start "<task description>" --scale <small|medium|large|ralph|hotfix>\n' +
      '       /vela start "<task>" --preset <auth|api-crud|bugfix|refactor|docs>',
      "warning"
    );
    return;
  }

  // ── M5-1: Prompt optimizer — warn on vague/insufficient requests ─────────
  const promptIssues = analyzeRequestQuality(cleanRequest);
  if (promptIssues.length > 0) {
    const tips = promptIssues.map((t) => `  • ${t}`).join("\n");
    ctx.ui.notify(
      `[Vela] Request quality check:\n${tips}\n\n` +
      `  Current: "${cleanRequest}"\n\n` +
      `  Tip: Add --force to skip this check, or refine your request for better results.`,
      "warning"
    );
    if (!argTokens.includes("--force")) return;
  }

  // Apply preset if specified
  if (presetName && !rawScale) {
    const def = loadPipelineDefinition(cwd);
    const preset = (def as any)?.presets?.[presetName];
    if (preset?.scale) rawScale = preset.scale;
    else {
      ctx.ui.notify(
        `[Vela] Unknown preset: "${presetName}". Available: auth, api-crud, bugfix, refactor, migration, docs`,
        "warning"
      );
      return;
    }
  }

  // If --scale not given, show selection menu
  if (!rawScale || !SCALE_TO_PIPELINE[rawScale]) {
    const scaleList = Object.entries(SCALE_DESCRIPTIONS)
      .map(([k, v]) => `  --scale ${k.padEnd(7)} → ${v}`)
      .join("\n");
    ctx.ui.notify(
      `[Vela] --scale is required. Options:\n${scaleList}\n\n` +
      `Example: /vela start "${cleanRequest}" --scale large`,
      "warning"
    );
    return;
  }

  const scale = rawScale;
  const pipelineType = SCALE_TO_PIPELINE[scale]!;

  // Block if there is already an active pipeline
  const existing = findActivePipelineState(cwd);
  if (existing) {
    ctx.ui.notify(
      `[Vela] Active pipeline already exists at step "${existing.current_step}". ` +
        "Use /vela cancel first.",
      "warning"
    );
    return;
  }

  // Clean up old cancelled artifacts and stale pipelines
  const cleaned = cleanupCancelledArtifacts(cwd, 24);
  const staleCleaned = cleanupStalePipelines(cwd);
  const totalCleaned = cleaned + staleCleaned;

  const taskType = detectTaskType(cleanRequest);

  // Git state snapshot
  const gitState = snapshotGitState(cwd);

  // Block on dirty working tree
  if (gitState.is_repo && !gitState.is_clean) {
    ctx.ui.notify(
      "[Vela] Working tree is dirty. Commit or stash changes before starting a pipeline.\n" +
        `  Dirty files: ${gitState.dirty_files}\n` +
        "  Run: git stash",
      "warning"
    );
    return;
  }

  // Ensure .vela/templates/pipeline.json is present
  ensurePipelineTemplate(cwd, ctx);

  // Resolve steps from definition (for init)
  const pipelineDef = loadPipelineDefinition(cwd);
  const steps = pipelineDef ? resolveSteps(pipelineDef, pipelineType) : [];
  const firstStep = steps[0];

  // Create artifact directory
  const ts = formatTimestamp();
  const slug = slugify(cleanRequest);
  const artifactDirName = `${ts}-${slug}`;
  const artifactDir = join(cwd, ".vela", "artifacts", artifactDirName);
  mkdirSync(artifactDir, { recursive: true });

  const pipelineId = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const state: PipelineState = {
    version: "1.1",
    pipeline_id: pipelineId,
    pipeline_type: pipelineType,
    status: "active",
    current_step: firstStep?.id ?? "init",
    current_step_index: 0,
    request: cleanRequest,
    task_type: taskType,
    type: taskType,
    scale,
    steps: steps.map((s) => s.id),
    completed_steps: [],
    revisions: {},
    git: gitState.is_repo
      ? {
          is_repo: true,
          base_branch: gitState.current_branch,
          current_branch: gitState.current_branch,
          pipeline_branch: null,
          checkpoint_hash: gitState.head_hash,
          commit_hash: null,
          stash_ref: gitState.stash_ref ?? null,
          remote: gitState.remote ?? null,
        }
      : undefined,
    baseline_sha: gitState.is_repo ? gitState.head_hash : null,
    artifact_dir: artifactDir,
    created_at: now,
    updated_at: now,
  };

  writeJSON(join(artifactDir, "pipeline-state.json"), state);
  writeJSON(join(artifactDir, "meta.json"), {
    pipeline_id: pipelineId,
    request: cleanRequest,
    task_type: taskType,
    created_at: now,
    vela_version: "1.0.0",
  });

  ensureGitignore(cwd);

  // Build compact route string: first two + … + last, or all if ≤5
  const stepIds = steps.map((s) => s.id);
  const route =
    stepIds.length <= 5
      ? stepIds.join(" → ")
      : `${stepIds.slice(0, 2).join(" → ")} → … → ${stepIds[stepIds.length - 1]}`;

  const currentMode = readVelaMode(cwd);

  const lines = [
    boxTop("⛵  VELA — Pipeline Launched"),
    boxLine(`${lbl("Course:")} ${cleanRequest}`),
    boxLine(`${lbl("Scale:")}  ${scale} → ${pipelineType}`),
    boxLine(`${lbl("Type:")}   ${taskType}`),
    boxLine(`${lbl("Mode:")}   ${currentMode === "pipeline" ? "🚀 pipeline" : "🔍 explorer"}`),
    boxLine(`${lbl("Route:")}  ${route}`),
    boxLine(`${lbl("Artifact:")} .vela/artifacts/${artifactDirName}`),
    ...(totalCleaned > 0 ? [boxLine(`Cleaned ${totalCleaned} old artifact(s).`)] : []),
    boxBot("use /vela mode pipeline for step focus"),
  ];

  ctx.ui.notify(lines.join("\n"), "info");

  // Update status bar to reflect new pipeline
  updateVelaStatus(ctx, cwd);
}

async function cmdStatus(parts: string[], ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "info");
    return;
  }

  const compact = parts.includes("--compact");

  const def = loadPipelineDefinition(cwd);
  const steps = def ? resolveSteps(def, state.pipeline_type) : [];
  const stepIdx = steps.findIndex((s) => s.id === state.current_step);
  const currentStep = steps[stepIdx];
  const completedCount = state.completed_steps?.length ?? stepIdx;
  const totalCount = steps.length;

  // Progress bar (12 chars wide)
  const barWidth = 12;
  const filled = Math.round((completedCount / Math.max(totalCount, 1)) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const elapsed = state.created_at
    ? Math.round((Date.now() - new Date(state.created_at).getTime()) / 60_000)
    : 0;

  // Compact one-liner (improvement #18)
  if (compact) {
    const actorIcon = actorEmoji(currentStep?.actor);
    ctx.ui.notify(
      `⛵ VELA  ·  ${actorIcon} ${state.current_step}  ${completedCount + 1}/${totalCount}  [${bar}]  ${elapsed}m${state.auto ? "  ⚡" : ""}`,
      "info"
    );
    return;
  }

  const artifactSlug =
    state._artifactDir?.split("/").pop() ?? state.artifact_dir.split("/").pop() ?? "";
  const revisions = state.revisions ?? {};

  // Build step grid: 3 columns, each cell 15 chars wide (improvement #17 with actor icons)
  const COLS = 3;
  const CELL = 16;
  const stepCells = steps.map((s, i) => {
    const isDone = state.completed_steps?.includes(s.id) ?? i < stepIdx;
    const isCurrent = s.id === state.current_step;
    const icon = isDone ? "✓" : isCurrent ? "▶" : "·";
    const label = isCurrent ? `${s.id}←` : s.id;
    return `${icon} ${label}`;
  });
  const stepRows: string[] = [];
  for (let i = 0; i < stepCells.length; i += COLS) {
    const row = stepCells.slice(i, i + COLS);
    stepRows.push(row.map((c) => c.padEnd(CELL)).join(" ").trimEnd());
  }

  const actorIcon = actorEmoji(currentStep?.actor);
  const modeLabel = currentStep?.mode ?? "??";

  const lines = [
    boxTop("⛵  VELA — Navigation Chart"),
    boxLine(`${lbl("Course:")} ${state.request}`),
    boxLine(`${lbl("Scale:")}  ${state.scale ?? state.pipeline_type}`),
    boxLine(`${lbl("Heading:")} ${state.current_step}  (${stepIdx + 1}/${totalCount})  ·  ${modeLabel}`),
    boxLine(`${lbl("Actor:")}  ${actorIcon} ${currentStep?.actor ?? "unknown"}`),
    boxSep(),
    boxLine(`Progress: [${bar}]  ${completedCount}/${totalCount}  ·  ${elapsed}m elapsed`),
    boxSep(),
    ...stepRows.map((r) => boxLine(r)),
  ];

  // Revisions with dot graph (improvement #20)
  const curRevs = revisions[state.current_step] ?? 0;
  if (curRevs > 0) {
    const maxRevs = currentStep?.max_revisions ?? 3;
    const dots = "●".repeat(Math.min(curRevs, maxRevs)) + "○".repeat(Math.max(0, maxRevs - curRevs));
    lines.push(boxLine(`Revisions: ${dots}  ${curRevs}/${maxRevs}`));
  }
  if (state.git?.pipeline_branch) {
    lines.push(boxLine(`Branch:  ${state.git.pipeline_branch}`));
  }
  if (state.auto) {
    lines.push(boxLine("⚡ Auto mode ON"));
  }
  if (state._stale) {
    lines.push(boxLine("⚠  Pipeline stale (>48h inactive)"));
  }
  lines.push(boxLine(`Artifact: .vela/artifacts/${artifactSlug}`));
  lines.push(boxBot("/vela status --compact for one-liner"));

  ctx.ui.notify(lines.join("\n"), "info");
}

/** Map actor string to emoji (improvement #16). */
function actorEmoji(actor?: string): string {
  switch (actor) {
    case "agent": return "⚙";
    case "user":  return "👤";
    case "pm":    return "🧠";
    default:      return "·";
  }
}

async function cmdTransition(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline to transition.", "warning");
    return;
  }

  const def = loadPipelineDefinition(cwd);
  if (!def) {
    ctx.ui.notify("[Vela] Pipeline definition not found.", "error" as Parameters<typeof ctx.ui.notify>[1]);
    return;
  }

  const result = transitionPipeline(state, def);

  if (!result.ok) {
    const missingList = result.missing ?? [];
    const hints = resolveExitGateHints(missingList, state?.current_step ?? "");
    const lines = [
      boxTop("⛵  VELA — Gate Not Met"),
      boxLine(`Step: ${state?.current_step}`),
      boxLine(result.error ?? "Exit gate not satisfied"),
      ...(missingList.length > 0 ? [boxSep(), ...missingList.map((m) => boxLine(`  ✗ ${m}`))] : []),
      ...(hints.length > 0 ? [boxSep(), ...hints.map((h) => boxLine(`  → ${h}`))] : []),
      boxBot("resolve missing items then /vela transition"),
    ];
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }

  if (result.completed) {
    ctx.ui.notify(
      [
        boxTop("⛵  VELA — Pipeline Complete"),
        boxLine("All steps done. Fair winds! ⚓"),
        boxBot(),
      ].join("\n"),
      "info"
    );
    return;
  }

  // Resolve actor for next step
  const freshState = findActivePipelineState(ctx.cwd);
  const freshDef = loadPipelineDefinition(ctx.cwd);
  const nextSteps = freshDef ? resolveSteps(freshDef, freshState?.pipeline_type ?? "") : [];
  const nextStepDef = nextSteps.find((s) => s.id === result.current_step);
  const actorIcon = actorEmoji(nextStepDef?.actor);

  ctx.ui.notify(
    [
      boxTop("⛵  VELA — Course Change"),
      boxLine(`${result.previous_step}  →  ${result.current_step}`),
      boxLine(`${lbl("Step:")}  ${result.current_step_name ?? result.current_step}`),
      boxLine(`${lbl("Mode:")}  ${result.current_mode ?? "unknown"}`),
      boxLine(`${lbl("Actor:")} ${actorIcon} ${nextStepDef?.actor ?? "unknown"}`),
      ...(nextStepDef?.actor === "agent"
        ? [boxLine("▸ Run /vela dispatch to execute this step")]
        : nextStepDef?.actor === "user"
        ? [boxLine("▸ Complete this step manually, then /vela record pass")]
        : []),
      boxBot(),
    ].join("\n"),
    "info"
  );

  // Update status bar step indicator
  updateVelaStatus(ctx, ctx.cwd);
}

async function cmdRecord(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = findActivePipelineState(ctx.cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const verdict = parts[0];
  if (!verdict) {
    ctx.ui.notify("Usage: /vela record <pass|fail|reject> [--summary TEXT]", "warning");
    return;
  }

  // Extract --summary flag
  const summaryIdx = parts.indexOf("--summary");
  const summary = summaryIdx >= 0 ? parts.slice(summaryIdx + 1).join(" ") : undefined;

  const result = recordStep(state, verdict, summary);
  if (!result.ok) {
    ctx.ui.notify(`[Vela] ${result.error}`, "warning");
    return;
  }

  const autoNote = result.auto_disabled
    ? "\n  ⚠ Auto mode disabled after 2 consecutive rejects."
    : "";

  const verdictIcon = result.verdict === "pass" ? "✓" : result.verdict === "fail" ? "✗" : "↩";

  ctx.ui.notify(
    `⛵ VELA  ·  ${verdictIcon} ${result.verdict?.toUpperCase()} — step "${result.step}" (rev ${result.revision})${autoNote}`,
    "info"
  );
}

async function cmdSubTransition(ctx: ExtensionCommandContext): Promise<void> {
  const state = findActivePipelineState(ctx.cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const result = subTransitionPipeline(state);
  if (!result.ok) {
    ctx.ui.notify(`[Vela] ${result.error}`, "warning");
    return;
  }

  if (result.completed) {
    ctx.ui.notify(
      `[Vela] All sub-phases completed for "${state.current_step}".`,
      "info"
    );
    return;
  }

  ctx.ui.notify(
    `[Vela] Sub-phase: ${result.previous_phase} → ${result.current_phase}\n` +
      (result.remaining?.length
        ? `  Remaining: ${result.remaining.join(", ")}`
        : "  (last sub-phase)"),
    "info"
  );
}

async function cmdBranch(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const modeIdx = parts.indexOf("--mode");
  const rawMode = modeIdx >= 0 ? parts[modeIdx + 1] : "auto";
  const mode = (["auto", "prompt", "none"].includes(rawMode ?? "")
    ? rawMode
    : "auto") as "auto" | "prompt" | "none";

  const result = createPipelineBranch(cwd, state, mode);

  if (!result.ok) {
    ctx.ui.notify(`[Vela] Branch error: ${result.error}`, "warning");
    return;
  }

  switch (result.action) {
    case "skipped":
      ctx.ui.notify("[Vela] Not a git repository. Branch step skipped.", "info");
      break;
    case "existing":
      ctx.ui.notify(
        `[Vela] Already on non-protected branch "${result.branch}". Using as pipeline branch.`,
        "info"
      );
      break;
    case "none":
      ctx.ui.notify(`[Vela] Branch creation skipped (mode: none).`, "info");
      break;
    case "prompt":
      ctx.ui.notify(
        `[Vela] Run this command to create the pipeline branch:\n  ${result.suggested_command}`,
        "info"
      );
      break;
    case "created":
      ctx.ui.notify(`[Vela] Branch "${result.branch}" created.`, "info");
      break;
  }
}

async function cmdCommit(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);
  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  const msgIdx = parts.indexOf("--message");
  const messageOverride = msgIdx >= 0 ? parts.slice(msgIdx + 1).join(" ") : undefined;

  const def = loadPipelineDefinition(cwd);
  const result = commitPipeline(cwd, state, def, messageOverride);

  if (!result.ok) {
    ctx.ui.notify(`[Vela] Commit failed: ${result.error}`, "warning");
    return;
  }

  switch (result.action) {
    case "skipped":
      ctx.ui.notify("[Vela] Not a git repository. Commit skipped.", "info");
      break;
    case "no_changes":
      ctx.ui.notify("[Vela] No changes to commit.", "info");
      break;
    case "committed":
      ctx.ui.notify(
        `[Vela] Committed: ${result.commit_message}\n  Hash: ${result.hash?.substring(0, 7)}`,
        "info"
      );
      break;
  }
}

async function cmdHistory(parts: string[], ctx: ExtensionCommandContext): Promise<void> {
  // --type filter (improvement #24)
  const typeIdx = parts.indexOf("--type");
  const typeFilter = typeIdx >= 0 ? parts[typeIdx + 1] : undefined;

  let pipelines = listPipelineHistory(ctx.cwd);

  if (typeFilter) {
    pipelines = pipelines.filter((p) => p.type === typeFilter || p.type.includes(typeFilter));
  }

  if (pipelines.length === 0) {
    const msg = typeFilter
      ? `[Vela] No pipeline history for type: ${typeFilter}`
      : "[Vela] No pipeline history.";
    ctx.ui.notify(msg, "info");
    return;
  }

  const lines = [
    boxTop("⛵  VELA — Pipeline History"),
    boxLine(`${"Date".padEnd(9)} ${"Status".padEnd(11)} ${"Step".padEnd(13)} Course`),
    boxSep(),
  ];
  for (const p of pipelines.slice(0, 20)) {
    const icon = p.status === "completed" ? "✓" : p.status === "cancelled" ? "✗" : "▶";
    const date = p.date;
    const status = `${icon} ${p.status}`.padEnd(11);
    const step = p.step.padEnd(13);
    const course = p.request.substring(0, 14);
    lines.push(boxLine(`${date}  ${status}  ${step}  ${course}`));
  }
  if (typeFilter) {
    lines.push(boxLine(`Filter: type=${typeFilter}  (${pipelines.length} results)`));
  }
  lines.push(boxBot());

  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Sprint Command ───────────────────────────────────────────────────────────

async function cmdSprint(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const sub = parts[0]?.toLowerCase();

  switch (sub) {
    case "run": {
      const request = parts.slice(1).join(" ").replace(/^["']|["']$/g, "").trim();
      if (!request) {
        ctx.ui.notify('Usage: /vela sprint run "<request>"', "warning");
        return;
      }
      await cmdSprintRun(request, cwd, ctx);
      break;
    }
    case "status": {
      const sprintId = parts[1];
      cmdSprintStatus(sprintId, cwd, ctx);
      break;
    }
    case "resume": {
      const sprintId = parts[1];
      await cmdSprintResume(sprintId, cwd, ctx);
      break;
    }
    case "cancel": {
      const sprintId = parts[1];
      cmdSprintCancel(sprintId, cwd, ctx);
      break;
    }
    default:
      ctx.ui.notify(
        [
          "[Vela] Sprint commands:",
          '  /vela sprint run "<request>"   — plan and execute a sprint',
          "  /vela sprint status [id]       — show sprint state",
          "  /vela sprint resume [id]       — resume an interrupted sprint",
          "  /vela sprint cancel [id]       — cancel an active sprint",
        ].join("\n"),
        "info"
      );
  }
}

async function cmdSprintRun(
  request: string,
  cwd: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  ctx.ui.notify(
    `[Vela] Planning sprint: "${request}"\n  Dispatching sprint planner...`,
    "info"
  );

  // Use sprint planner agent to decompose the request
  const planResult = await runVelaAgent({
    role: "sprint-planner",
    cwd,
    artifactDir: join(cwd, ".vela", "state"),
    request,
    taskType: "code",
  });

  // Parse slices from planner output
  let slices: Array<{ id: string; title: string; description: string; depends_on: string[] }> = [];
  let title = request.substring(0, 50);

  if (planResult.ok && planResult.text) {
    try {
      // Try to extract JSON from the planner response
      const jsonMatch = planResult.text.match(/```json\n([\s\S]*?)\n```/) ||
                        planResult.text.match(/\{[\s\S]*"slices"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as {
          title?: string;
          slices?: typeof slices;
        };
        if (parsed.title) title = parsed.title;
        if (Array.isArray(parsed.slices)) slices = parsed.slices;
      }
    } catch {
      // Fallback: create a single-slice sprint
    }
  }

  // Fallback: single slice
  if (slices.length === 0) {
    slices = [{ id: "slice-01", title: request.substring(0, 60), description: request, depends_on: [] }];
  }

  // Create the sprint
  const plan = createSprint({ title, request, slices }, cwd);
  updateSprintStatus(plan.id, "running", cwd);

  // Show DAG visualization at sprint start (improvement #28)
  const dagPreview = buildSprintDagPreview(slices);
  ctx.ui.notify(
    [
      boxTop(`🏃  VELA Sprint — ${plan.title}`),
      boxLine(`ID: ${plan.id}`),
      boxLine(`Slices: ${slices.length}`),
      boxSep(),
      ...slices.map((s) => {
        const deps = s.depends_on.length > 0 ? ` ← ${s.depends_on.join(", ")}` : "";
        return boxLine(`  • ${s.id}: ${s.title}${deps}`);
      }),
      ...(dagPreview ? [boxSep(), ...dagPreview.split("\n").map((l) => boxLine(l))] : []),
      boxSep(),
      boxLine("Starting execution..."),
      boxBot(),
    ].join("\n"),
    "info"
  );

  // Execute slices sequentially
  await executeSprintSlices(plan.id, cwd, ctx);
}

async function executeSprintSlices(
  sprintId: string,
  cwd: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  let iteration = 0;

  while (true) {
    iteration++;
    const plan = loadSprint(sprintId, cwd);
    const next = getNextSlice(plan);

    if (next.action === "complete") {
      updateSprintStatus(sprintId, "done", cwd);
      try {
        const completedPlan = loadSprint(sprintId, cwd);
        const summaryPath = generateSprintSummary(completedPlan, cwd);
        ctx.ui.notify(
          `[Vela] Sprint completed!\n  Summary: ${summaryPath}`,
          "info"
        );
      } catch {
        ctx.ui.notify("[Vela] Sprint completed!", "info");
      }
      return;
    }

    if (next.action === "halt" || next.action === "blocked") {
      updateSprintStatus(sprintId, "failed", cwd);
      ctx.ui.notify(`[Vela] Sprint stopped: ${next.reason}`, "warning");
      return;
    }

    if (next.action === "run" && next.slice) {
      const slice = next.slice;
      const pct = Math.round((plan.completed_slices / plan.total_slices) * 100);
      // ETA estimation (improvement #30): avg time of completed slices
      const etaStr = estimateSprintEta(plan);
      ctx.ui.notify(
        `[Vela] [${pct}%] Executing slice ${iteration}/${plan.total_slices}: ${slice.title}${etaStr ? `  (${etaStr} remaining)` : ""}`,
        "info"
      );

      updateSliceStatus(sprintId, slice.id, { status: "queued" }, cwd);
      updateSliceStatus(sprintId, slice.id, { status: "running", started_at: new Date().toISOString() }, cwd);

      const context = buildSliceContext(plan, slice);
      const sliceRequest = context
        ? `## Previous slice context\n${context}\n\n## Current task\n${slice.request || slice.title}`
        : (slice.request || slice.title);

      // Run the full pipeline for this slice via dispatch
      const result = await runVelaAgent({
        role: "executor",
        cwd,
        artifactDir: join(cwd, ".vela", "artifacts", `sprint-${sprintId}-${slice.id}`),
        request: sliceRequest,
        taskType: "code",
      });

      if (result.ok) {
        updateSliceStatus(sprintId, slice.id, {
          status: "done",
          result: result.text?.substring(0, 200),
          completed_at: new Date().toISOString(),
        }, cwd);
        ctx.ui.notify(`[Vela] Slice done: ${slice.title}`, "info");
      } else {
        updateSliceStatus(sprintId, slice.id, {
          status: "failed",
          result: result.error ?? "unknown error",
          completed_at: new Date().toISOString(),
        }, cwd);
        ctx.ui.notify(`[Vela] Slice failed: ${slice.title} — ${result.error}`, "warning");
        // Halt on slice failure
        updateSprintStatus(sprintId, "failed", cwd);
        return;
      }
    }
  }
}

function cmdSprintStatus(
  sprintId: string | undefined,
  cwd: string,
  ctx: ExtensionCommandContext
): void {
  const STATUS_ICON: Record<string, string> = {
    planned: "⬜", running: "🔵", done: "✅", failed: "❌", cancelled: "🚫",
    queued: "🔲", skipped: "⏭",
  };

  if (sprintId) {
    try {
      const plan = loadSprint(sprintId, cwd);
      formatSprintStatus(plan, STATUS_ICON, ctx);
    } catch (e) {
      ctx.ui.notify(`[Vela] Sprint not found: ${sprintId}`, "warning");
    }
    return;
  }

  const active = findActiveSprint(cwd);
  if (active) {
    formatSprintStatus(active, STATUS_ICON, ctx);
    return;
  }

  const sprints = listSprints(cwd);
  if (sprints.length === 0) {
    ctx.ui.notify("[Vela] No sprint history.", "info");
    return;
  }

  const lines = ["[Vela] Recent sprints:"];
  for (const s of sprints.slice(0, 10)) {
    const icon = STATUS_ICON[s.status] ?? "❓";
    lines.push(`  ${icon} ${s.id.split("-").slice(2).join("-").substring(0, 20).padEnd(20)} ${s.status.padEnd(10)} ${s.completed_slices}/${s.total_slices} slices`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function renderSliceDag(plan: SprintPlan, icons: Record<string, string>): string {
  const slices = plan.slices;
  if (slices.length === 0) return "";

  // BFS to assign levels
  const levels = new Map<string, number>();
  const queue: string[] = [];

  for (const s of slices) {
    if (s.depends_on.length === 0) {
      levels.set(s.id, 0);
      queue.push(s.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const lvl = levels.get(id)!;
    for (const s of slices) {
      if (s.depends_on.includes(id)) {
        const existing = levels.get(s.id) ?? -1;
        if (existing < lvl + 1) {
          levels.set(s.id, lvl + 1);
          queue.push(s.id);
        }
      }
    }
  }

  // Slices not reached by BFS (disconnected from roots) get level 0
  for (const s of slices) {
    if (!levels.has(s.id)) levels.set(s.id, 0);
  }

  const maxLevel = Math.max(...levels.values());
  const lines: string[] = ["  DAG:"];
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const atLevel = slices.filter((s) => levels.get(s.id) === lvl);
    const row = atLevel.map((s) => `[${icons[s.status] ?? "?"} ${s.id}]`).join("  ");
    lines.push(`    ${row}`);
    if (lvl < maxLevel) lines.push("      ▼");
  }
  return lines.join("\n");
}

function formatSprintStatus(
  plan: SprintPlan,
  icons: Record<string, string>,
  ctx: ExtensionCommandContext
): void {
  // Elapsed time
  const elapsedMs =
    new Date(plan.updated_at).getTime() - new Date(plan.created_at).getTime();
  const elapsedStr =
    elapsedMs < 60000
      ? `${(elapsedMs / 1000).toFixed(0)}s`
      : `${(elapsedMs / 60000).toFixed(1)}m`;

  // Counts
  const done    = plan.slices.filter((s) => s.status === "done").length;
  const failed  = plan.slices.filter((s) => s.status === "failed").length;
  const running = plan.slices.filter((s) => s.status === "running").length;
  const pending = plan.slices.filter(
    (s) => s.status === "planned" || s.status === "queued"
  ).length;

  const countParts = [`${done} done`];
  if (failed > 0) countParts.push(`${failed} failed`);
  if (running > 0) countParts.push(`${running} running`);
  countParts.push(`${pending} pending`);
  countParts.push(`(${elapsedStr})`);

  const lines = [
    `[Vela] Sprint: ${plan.title}`,
    `  ID:       ${plan.id}`,
    `  Status:   ${icons[plan.status] ?? ""} ${plan.status}`,
    `  Progress: ${plan.completed_slices}/${plan.total_slices} slices — ${countParts.join("  ")}`,
    "",
    "  Slices:",
  ];

  for (const s of plan.slices) {
    const icon = icons[s.status] ?? "❓";
    const deps = s.depends_on.length > 0 ? ` (deps: ${s.depends_on.join(", ")})` : "";
    let dur = "";
    if (s.started_at && s.completed_at) {
      const ms =
        new Date(s.completed_at).getTime() - new Date(s.started_at).getTime();
      dur = ` [${(ms / 1000).toFixed(1)}s]`;
    }
    lines.push(`    ${icon} ${s.id}: ${s.title}${deps}${dur}`);
  }

  lines.push("");
  lines.push(renderSliceDag(plan, icons));

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdSprintResume(
  sprintId: string | undefined,
  cwd: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  let plan: SprintPlan;
  if (sprintId) {
    try {
      plan = loadSprint(sprintId, cwd);
    } catch {
      ctx.ui.notify(`[Vela] Sprint not found: ${sprintId}`, "warning");
      return;
    }
  } else {
    const resumable = findResumableSprint(cwd);
    if (!resumable) {
      ctx.ui.notify("[Vela] No active or failed sprint to resume.", "info");
      return;
    }
    plan = resumable;
  }

  // If sprint was failed, reset failed slices → queued and reactivate
  if (plan.status === "failed") {
    const failedSlices = plan.slices.filter((s) => s.status === "failed");
    for (const s of failedSlices) {
      updateSliceStatus(plan.id, s.id, { status: "queued" }, cwd);
    }
    updateSprintStatus(plan.id, "running", cwd);
    ctx.ui.notify(
      `[Vela] Restarting failed sprint: ${plan.title}\n  Reset ${failedSlices.length} failed slice(s) → queued`,
      "info"
    );
  } else {
    ctx.ui.notify(
      `[Vela] Resuming sprint: ${plan.title} (${plan.completed_slices}/${plan.total_slices} done)`,
      "info"
    );
  }

  await executeSprintSlices(plan.id, cwd, ctx);
}

function cmdSprintCancel(
  sprintId: string | undefined,
  cwd: string,
  ctx: ExtensionCommandContext
): void {
  let plan: SprintPlan;
  if (sprintId) {
    try {
      plan = loadSprint(sprintId, cwd);
    } catch {
      ctx.ui.notify(`[Vela] Sprint not found: ${sprintId}`, "warning");
      return;
    }
  } else {
    const active = findActiveSprint(cwd);
    if (!active) {
      ctx.ui.notify("[Vela] No active sprint to cancel.", "info");
      return;
    }
    plan = active;
  }

  // Cancel running slices
  for (const s of plan.slices) {
    if (s.status === "running") {
      updateSliceStatus(plan.id, s.id, { status: "skipped", result: "Cancelled by user", completed_at: new Date().toISOString() }, cwd);
    }
  }
  updateSprintStatus(plan.id, "cancelled", cwd);
  ctx.ui.notify(`[Vela] Sprint cancelled: ${plan.title}`, "info");
}

async function cmdDispatch(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline.", "warning");
    return;
  }

  // Determine role: --role flag, or derive from current step
  const roleIdx = parts.indexOf("--role");
  const role = roleIdx >= 0 ? parts[roleIdx + 1] : state.current_step;

  if (!role) {
    ctx.ui.notify(
      `[Vela] No role specified. Available: ${getAvailableRoles().join(", ")}`,
      "warning"
    );
    return;
  }

  const artifactDir = state._artifactDir ?? state.artifact_dir;
  if (!artifactDir) {
    ctx.ui.notify("[Vela] No artifact directory found.", "warning");
    return;
  }

  const def = loadPipelineDefinition(cwd);
  const mode = getCurrentMode(state, def);

  // Show estimated time based on role timeout (improvement #23)
  const roleConfig = getRoleConfig(role);
  const etaMs = roleConfig?.timeoutMs ?? 300_000;
  const etaMin = Math.round(etaMs / 60_000);
  const etaStr = etaMin >= 1 ? `~${etaMin}m` : `~${Math.round(etaMs / 1000)}s`;

  ctx.ui.notify(
    `⛵ VELA  ·  Dispatching ${role}… (${mode} mode  ·  est. ${etaStr})`,
    "info"
  );

  const result = await runVelaAgent({
    role,
    cwd,
    artifactDir,
    request: state.request,
    taskType: state.task_type ?? state.type ?? "code",
    pipelineMode: mode,
  });

  if (!result.ok) {
    ctx.ui.notify(
      [
        boxTop("⛵  VELA — Dispatch Failed"),
        boxLine(`${lbl("Role:")}    ${role}`),
        boxLine(`${lbl("Error:")}   ${result.error ?? "unknown"}`),
        boxBot(),
      ].join("\n"),
      "warning"
    );
    return;
  }

  const duration = result.durationMs ? `${Math.round(result.durationMs / 1000)}s` : "";
  ctx.ui.notify(
    [
      boxTop("⛵  VELA — Agent Complete"),
      boxLine(`${lbl("Role:")}     ${role}`),
      boxLine(`${lbl("Artifact:")} ${result.artifact ?? "—"}`),
      ...(duration ? [boxLine(`${lbl("Duration:")} ${duration}`)] : []),
      boxSep(),
      boxLine("▸ Run /vela transition when ready"),
      boxBot(),
    ].join("\n"),
    "info"
  );
}

async function cmdAuto(ctx: ExtensionCommandContext): Promise<void> {
  const state = findActivePipelineState(ctx.cwd);
  if (!state) { ctx.ui.notify("[Vela] No active pipeline.", "warning"); return; }

  const wasAuto = state.auto === true;

  if (wasAuto) {
    // Turn OFF
    state.auto = false;
    state.updated_at = new Date().toISOString();
    persistState(state);
    updateVelaStatus(ctx, ctx.cwd);
    ctx.ui.notify("⛵ VELA  ·  Auto mode OFF", "info");
    return;
  }

  // Turn ON and start loop
  state.auto = true;
  state.auto_reject_count = 0;
  state.updated_at = new Date().toISOString();
  persistState(state);
  updateVelaStatus(ctx, ctx.cwd);
  ctx.ui.notify("⛵ VELA  ·  ⚡ Auto mode ON — starting auto-dispatch loop…", "info");

  await runAutoLoop(ctx);
}

// verify 재시도 루프 포함
async function runAutoLoop(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const MAX_ITERATIONS = 30;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const state = findActivePipelineState(cwd);
    if (!state || !state.auto || state.status !== "active") break;

    const def = loadPipelineDefinition(cwd);
    if (!def) break;

    const steps = resolveSteps(def, state.pipeline_type);
    const currentStep = steps.find(s => s.id === state.current_step);
    if (!currentStep) break;

    // user/pm steps: pause and wait for manual action
    if (currentStep.actor === "user" || currentStep.actor === "pm") {
      ctx.ui.notify(
        `⛵ VELA  ·  Auto paused at "${state.current_step}" (${actorEmoji(currentStep.actor)} ${currentStep.actor} step) — complete manually then /vela transition`,
        "info"
      );
      break;
    }

    // Dispatch agent for current step (improvement #22: show iteration count)
    ctx.ui.notify(`⛵ VELA  ·  Auto [${iteration}/${MAX_ITERATIONS}] dispatching ${state.current_step}…`, "info");
    const artifactDir = state._artifactDir ?? state.artifact_dir;
    const mode = getCurrentMode(state, def);
    const dispatchResult = await runVelaAgent({
      role: state.current_step,
      cwd,
      artifactDir,
      request: state.request,
      taskType: state.task_type ?? "code",
      pipelineMode: mode,
    });

    if (!dispatchResult.ok) {
      ctx.ui.notify(`[Vela] Auto: agent failed (${state.current_step}): ${dispatchResult.error}`, "warning");
      // Disable auto on failure
      const s2 = findActivePipelineState(cwd);
      if (s2) { s2.auto = false; persistState(s2); }
      break;
    }

    // Record pass
    const freshState = findActivePipelineState(cwd);
    if (!freshState) break;
    recordStep(freshState, "pass");

    // Try to transition
    const freshState2 = findActivePipelineState(cwd);
    if (!freshState2) break;
    const freshDef = loadPipelineDefinition(cwd);
    if (!freshDef) break;
    const result = transitionPipeline(freshState2, freshDef);

    if (result.completed) {
      ctx.ui.notify(
        [
          boxTop("⛵  VELA — Auto Complete"),
          boxLine("All steps done. Fair winds! ⚓"),
          boxBot(),
        ].join("\n"),
        "info"
      );
      break;
    }

    if (!result.ok) {
      ctx.ui.notify(
        `⛵ VELA  ·  Auto blocked at "${freshState2.current_step}" — ${result.error}${result.missing?.length ? ` (missing: ${result.missing.join(", ")})` : ""}`,
        "warning"
      );
      break;
    }

    ctx.ui.notify(`⛵ VELA  ·  ${result.previous_step}  →  ${result.current_step}`, "info");
    updateVelaStatus(ctx, cwd);
  }
}


async function cmdAnalyze(
  parts: string[],
  ctx: ExtensionCommandContext
): Promise<void> {
  const cwd = ctx.cwd;
  const sub = parts[0]?.toLowerCase();

  if (!sub || sub === "help") {
    ctx.ui.notify(
      [
        "[Vela] Analyze commands:",
        "  /vela analyze deps              — npm audit + outdated (free)",
        "  /vela analyze security          — security scan via AI agent",
        "  /vela analyze quality           — code quality analysis",
        "  /vela analyze all               — all analyses",
      ].join("\n"),
      "info"
    );
    return;
  }

  const perspectivesMap: Record<string, string[]> = {
    deps:     [],
    security: ["security"],
    quality:  ["quality"],
    all:      ["security", "quality"],
  };

  const perspectives = perspectivesMap[sub];
  if (!perspectives) {
    ctx.ui.notify(`[Vela] Unknown analyze target: ${sub}. Use: deps, security, quality, all`, "warning");
    return;
  }

  // deps: shell-based npm audit
  if (sub === "deps" || sub === "all") {
    ctx.ui.notify("[Vela] Running npm audit...", "info");
    try {
      const { execFileSync } = await import("node:child_process");
      const audit = execFileSync("npm", ["audit", "--json"], {
        cwd, timeout: 30_000, stdio: "pipe",
      }).toString();
      const auditData = JSON.parse(audit) as { metadata?: { vulnerabilities?: Record<string, number> } };
      const vulns = auditData.metadata?.vulnerabilities ?? {};
      const total = Object.values(vulns).reduce((a, b) => a + b, 0);
      ctx.ui.notify(
        `[Vela] npm audit: ${total} vulnerabilities\n` +
        Object.entries(vulns).map(([k, v]) => `  ${k}: ${v}`).join("\n"),
        total > 0 ? "warning" : "info"
      );
    } catch (e) {
      ctx.ui.notify(`[Vela] npm audit failed: ${(e as Error).message}`, "warning");
    }
  }

  // AI analyses
  const stateForAnalyze = findActivePipelineState(cwd);
  const artifactDir = stateForAnalyze?._artifactDir
    ?? stateForAnalyze?.artifact_dir
    ?? join(cwd, ".vela", "analyze");
  mkdirSync(artifactDir, { recursive: true });

  for (const perspective of perspectives) {
    ctx.ui.notify(`[Vela] Analyzing ${perspective}...`, "info");
    const result = await runVelaAgent({
      role: "researcher",
      cwd,
      artifactDir,
      request: `Analyze the codebase for ${perspective} issues. Focus: ${perspective === "security" ? "vulnerabilities, injection, auth, sensitive data" : "code quality, maintainability, test coverage, performance"}`,
      taskType: "analysis",
      extraContext: `Perspective: ${perspective}`,
    });

    if (result.ok) {
      ctx.ui.notify(`[Vela] ${perspective} analysis complete: ${result.artifact}`, "info");
    } else {
      ctx.ui.notify(`[Vela] ${perspective} analysis failed: ${result.error}`, "warning");
    }
  }
}

async function cmdExplorer(args: string[], ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const sub = args[0]?.toLowerCase();
  const statePath = join(cwd, ".vela", "state", "explorer.json");

  let enabled = true;
  if (existsSync(statePath)) {
    try { enabled = (JSON.parse(readFileSync(statePath, "utf8")) as { enabled?: boolean }).enabled ?? true; } catch {}
  }

  if (sub === "off") {
    mkdirSync(join(cwd, ".vela", "state"), { recursive: true });
    writeJSON(statePath, { enabled: false, updated_at: new Date().toISOString() });
    ctx.ui.notify(
      [
        boxTop("🔍  VELA — Explorer Mode OFF"),
        boxLine("Fact-check enforcement DISABLED."),
        boxLine("AI may now answer from memory without tool calls."),
        boxLine("Use /vela explorer on to re-enable."),
        boxLine("Tip: /vela mode pipeline for pipeline focus."),
        boxBot("restart session to apply"),
      ].join("\n"),
      "info"
    );
  } else if (sub === "on") {
    mkdirSync(join(cwd, ".vela", "state"), { recursive: true });
    writeJSON(statePath, { enabled: true, updated_at: new Date().toISOString() });
    ctx.ui.notify(
      [
        boxTop("🔍  VELA — Explorer Mode ON"),
        boxLine("Fact-check enforcement ENABLED."),
        boxLine("Rules:  1. Verify before claiming (use tools)"),
        boxLine("        2. Cite every code claim [file:line]"),
        boxLine("        3. Glob first, Read second"),
        boxBot("restart session to apply"),
      ].join("\n"),
      "info"
    );
  } else if (sub === "status") {
    // improvement #27: compact status
    ctx.ui.notify(
      [
        boxTop("🔍  VELA — Explorer Mode"),
        boxLine(`Status:   ${enabled ? "ON  — fact-check enforced" : "OFF — memory answers allowed"}`),
        boxLine(""),
        boxLine("Rules when ON:"),
        boxLine("  1. Verify before claiming (use Read/Grep/Glob)"),
        boxLine("  2. Cite every claim: [path/to/file.ts:line]"),
        boxLine("  3. Distinguish fact from inference"),
        boxLine("  4. No assumed structure — enumerate with Glob"),
        boxLine("  5. Tools first, synthesis second"),
        boxLine(""),
        boxLine("Toggle:   /vela explorer on | off"),
        boxLine("Switch:   /vela mode pipeline | explorer"),
        boxBot("restart session after toggle"),
      ].join("\n"),
      "info"
    );
  } else {
    ctx.ui.notify(
      [
        boxTop("🔍  VELA — Explorer Mode"),
        boxLine(`Status:   ${enabled ? "ON  (fact-check enforced)" : "OFF"}`),
        boxLine(""),
        boxLine("Default:  always ON"),
        boxLine("Toggle:   /vela explorer on | off"),
        boxLine("Full:     /vela explorer status"),
        boxLine("Switch:   /vela mode pipeline | explorer"),
        boxBot("restart session to apply changes"),
      ].join("\n"),
      "info"
    );
  }
}

// ─── Mode Command ─────────────────────────────────────────────────────────────

/**
 * /vela mode             — show current mode and toggle
 * /vela mode pipeline    — switch to pipeline mode
 * /vela mode explorer    — switch to explorer mode
 *
 * Pipeline mode: focused on executing the current pipeline step
 * Explorer mode: fact-check enforcement (verify before claiming)
 *
 * Shift+Tab also toggles between modes (if SDK supports key events).
 */
async function cmdMode(parts: string[], ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const current = readVelaMode(cwd);
  const arg = parts[0]?.toLowerCase();

  if (!arg) {
    // Show status and toggle
    const next: VelaMode = current === "explorer" ? "pipeline" : "explorer";
    writeVelaMode(cwd, next);
    updateVelaStatus(ctx, cwd);

    const fromLabel = current === "explorer" ? "🔍 Explorer" : "🚀 Pipeline";
    const toLabel = next === "explorer" ? "🔍 Explorer" : "🚀 Pipeline";
    const toDesc = next === "explorer"
      ? "Fact-check enforcement active — verify before claiming."
      : "Pipeline execution focus — follow current step precisely.";

    ctx.ui.notify(
      [
        boxTop("⛵  VELA — Mode Switch"),
        boxLine(`${fromLabel}  →  ${toLabel}`),
        boxLine(""),
        boxLine(toDesc),
        ...(next === "explorer"
          ? [boxLine("Rules: verify, cite, tools-first")]
          : [boxLine("Commands: /vela status · dispatch · transition")]),
        boxLine(""),
        boxLine("Tip: Shift+Tab also toggles mode"),
        boxBot("changes take effect immediately"),
      ].join("\n"),
      "info"
    );
    return;
  }

  if (arg !== "pipeline" && arg !== "explorer") {
    ctx.ui.notify(
      [
        boxTop("⛵  VELA — Mode"),
        boxLine(`Current:  ${current === "pipeline" ? "🚀 pipeline" : "🔍 explorer"}`),
        boxLine(""),
        boxLine("Usage:  /vela mode             toggle"),
        boxLine("        /vela mode pipeline     pipeline focus"),
        boxLine("        /vela mode explorer     explorer (fact-check)"),
        boxLine(""),
        boxLine("Shortcut: Shift+Tab to toggle"),
        boxBot(),
      ].join("\n"),
      "info"
    );
    return;
  }

  const target = arg as VelaMode;
  if (target === current) {
    ctx.ui.notify(
      `⛵ VELA  ·  Already in ${target === "pipeline" ? "🚀 pipeline" : "🔍 explorer"} mode.`,
      "info"
    );
    return;
  }

  writeVelaMode(cwd, target);
  updateVelaStatus(ctx, cwd);

  const label = target === "pipeline" ? "🚀 Pipeline Mode" : "🔍 Explorer Mode";
  const desc = target === "explorer"
    ? "Fact-check enforcement active — verify before claiming."
    : "Pipeline execution focus — follow current step precisely.";

  ctx.ui.notify(
    [
      boxTop(`⛵  VELA — ${label}`),
      boxLine(desc),
      boxLine(""),
      ...(target === "explorer"
        ? [
            boxLine("Rules:"),
            boxLine("  1. Verify before claiming (use tools)"),
            boxLine("  2. Cite every claim [path:line]"),
            boxLine("  3. Tools first, synthesis second"),
          ]
        : [
            boxLine("Quick commands:"),
            boxLine("  /vela status   — current step"),
            boxLine("  /vela dispatch — run agent"),
            boxLine("  /vela record pass|fail"),
          ]),
      boxBot("Shift+Tab to switch back"),
    ].join("\n"),
    "info"
  );
}

async function cmdCancel(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;
  const state = findActivePipelineState(cwd);

  if (!state) {
    ctx.ui.notify("[Vela] No active pipeline to cancel.", "info");
    return;
  }

  state.status = "cancelled";
  state.updated_at = new Date().toISOString();

  if (state._path) {
    const clean = { ...state };
    delete clean._path;
    delete clean._artifactDir;
    delete clean._stale;
    writeJSON(state._path, clean);
  }

  const hints: string[] = [];
  if (state.git?.is_repo) {
    if (state.git.pipeline_branch && state.git.base_branch) {
      hints.push(`Restore branch:  git checkout ${state.git.base_branch}`);
      hints.push(`Delete branch:   git branch -d ${state.git.pipeline_branch}`);
    }
    if (state.git.checkpoint_hash) {
      hints.push(`View changes:    git diff ${state.git.checkpoint_hash.slice(0, 7)}..HEAD`);
    }
    if (state.git.stash_ref) {
      hints.push(`Restore stash:   git stash pop`);
    }
  }
  hints.push("Restart:         /vela start \"<request>\" --scale <scale>");

  const cancelLines = [
    boxTop("⛵  VELA — Pipeline Cancelled"),
    boxLine(`Stopped at:  ${state.current_step}`),
    boxLine(`Request:     ${state.request.substring(0, 40)}`),
    boxLine(`Artifact:    .vela/artifacts/${state._artifactDir?.split("/").pop() ?? ""}`),
    boxSep(),
    ...hints.map((h) => boxLine(h)),
    boxBot(),
  ];
  ctx.ui.notify(cancelLines.join("\n"), "info");
  updateVelaStatus(ctx, cwd);
}

function cmdHelp(ctx: ExtensionCommandContext): void {
  const cwd = ctx.cwd;
  const mode = readVelaMode(cwd);
  const state = findActivePipelineState(cwd);
  const modeLabel = mode === "pipeline" ? "🚀 pipeline" : "🔍 explorer";

  const lines = [
    boxTop("⛵  VELA — Command Reference"),
    boxLine(`Current mode: ${modeLabel}  (Shift+Tab or /vela mode to switch)`),
    boxLine(""),
  ];

  // Mode-specific section highlighted at top (improvement #11)
  if (mode === "pipeline" && state) {
    lines.push(
      boxLine("▶ ACTIVE PIPELINE — Quick actions:"),
      boxLine("  /vela status [--compact]"),
      boxLine("  /vela dispatch        run agent for current step"),
      boxLine("  /vela transition      advance to next step"),
      boxLine("  /vela record pass|fail|reject"),
      boxLine(""),
    );
  } else if (mode === "explorer") {
    lines.push(
      boxLine("▶ EXPLORER MODE — Fact-check rules:"),
      boxLine("  Verify before claiming · Cite every claim"),
      boxLine("  Use tools first (Read/Grep/Glob)"),
      boxLine("  /vela explorer status  — full rule list"),
      boxLine(""),
    );
  }

  lines.push(
    boxLine("PIPELINE"),
    boxLine('  /vela start "<req>" --scale SCALE'),
    boxLine("  /vela status [--compact]"),
    boxLine("  /vela transition"),
    boxLine("  /vela record <pass|fail|reject> [--summary TEXT]"),
    boxLine("  /vela sub-transition"),
    boxLine("  /vela dispatch [--role ROLE]"),
    boxLine("  /vela branch [--mode auto|prompt|none]"),
    boxLine("  /vela commit [--message TEXT]"),
    boxLine("  /vela auto / history [--type TYPE] / cancel"),
    boxLine(""),
    boxLine("SCALES"),
    boxLine("  small  → trivial   (4 steps)"),
    boxLine("  medium → quick     (6 steps)"),
    boxLine("  large  → standard  (12 steps)"),
    boxLine("  ralph  → TDD loop  (execute ↔ verify ×10)"),
    boxLine("  hotfix → patch     (docs/config only)"),
    boxLine(""),
    boxLine("MODE"),
    boxLine("  /vela mode               toggle pipeline ↔ explorer"),
    boxLine("  /vela mode pipeline      switch to pipeline mode"),
    boxLine("  /vela mode explorer      switch to explorer mode"),
    boxLine("  Shift+Tab                keyboard shortcut"),
    boxLine(""),
    boxLine("SPRINT"),
    boxLine('  /vela sprint run "<req>"'),
    boxLine("  /vela sprint status / resume / cancel"),
    boxLine(""),
    boxLine("ANALYZE"),
    boxLine("  /vela analyze deps / security / quality / all"),
    boxLine(""),
    boxLine("EXPLORER"),
    boxLine("  /vela explorer           quick status"),
    boxLine("  /vela explorer status    full rule list"),
    boxLine("  /vela explorer on|off    toggle (default: ON)"),
    boxLine(""),
    boxBot(),
  );

  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * M5-1: Prompt optimizer
 *
 * Analyzes the task request for common quality issues that reduce pipeline
 * effectiveness. Returns a list of human-readable suggestions. Empty list
 * means the request is acceptable.
 */
function analyzeRequestQuality(request: string): string[] {
  const issues: string[] = [];
  const words = request.trim().split(/\s+/);
  const lower = request.toLowerCase();

  // Too short — less than 4 words is almost always vague
  if (words.length < 4) {
    issues.push(
      "Request is too short. Describe WHAT, WHERE, and WHY.\n" +
      '    Better: "Add user email validation to the registration form in src/auth/register.ts"'
    );
  }

  // Pure single-word actions with no target ("fix", "add", "update", "change", "refactor")
  const vagueVerbs = /^(fix|add|update|change|refactor|improve|modify|edit|delete|remove)$/i;
  if (words.length === 1 && vagueVerbs.test(words[0])) {
    issues.push(`Single verb "${words[0]}" tells Vela nothing — add a subject and context.`);
  }

  // Missing file/module/path hint for code tasks (check only when not docs/analysis)
  const isDocOrAnalysis = /\b(doc|docs|readme|comment|analyze|analyse|analysis|report)\b/.test(lower);
  const hasLocation = /\b(in|at|on|for|from|inside|within)\b/.test(lower) ||
    /[./]/.test(request) ||        // path-like token
    /src|lib|test|spec|api|ui|db|schema|model|controller|service|component/i.test(request);
  if (!isDocOrAnalysis && words.length < 10 && !hasLocation) {
    issues.push(
      "No file/module location found. Mention where the change goes.\n" +
      '    Example: "…in src/api/users.ts" or "…in the UserService class"'
    );
  }

  // Potentially ambiguous pronouns without antecedent (it, this, that)
  if (/\b(it|this|that)\b/.test(lower) && words.length < 8) {
    issues.push(
      '"it/this/that" is ambiguous in a short request. Replace with the concrete subject.'
    );
  }

  // No acceptance criterion for large tasks (>= 8 words but no "should", "must", "so that", "when", "expect")
  const hasAcceptance = /\b(should|must|so that|when|expect|ensure|verify|assert)\b/.test(lower);
  if (words.length >= 8 && !hasAcceptance) {
    issues.push(
      "Consider adding acceptance criteria (\"…so that …\", \"…should …\") to guide the verify step."
    );
  }

  return issues;
}

function detectTaskType(request: string): string {
  const lower = request.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|regression)\b/.test(lower)) return "code-bug";
  if (/\b(refactor|cleanup|clean up|restructure|reorganize)\b/.test(lower)) return "code-refactor";
  if (/\b(doc|docs|documentation|readme|comment|jsdoc)\b/.test(lower)) return "docs";
  if (/\b(analyze|analyse|analysis|report|audit)\b/.test(lower)) return "analysis";
  return "code";
}

function ensurePipelineTemplate(cwd: string, ctx: ExtensionCommandContext): void {
  const dest = join(cwd, ".vela", "templates", "pipeline.json");
  if (existsSync(dest)) return;

  const candidates = [
    new URL("./templates/pipeline.json", import.meta.url).pathname,
    join(new URL(".", import.meta.url).pathname, "templates", "pipeline.json"),
  ];

  const src = candidates.find((p) => existsSync(p));
  if (!src) {
    ctx.ui.notify(
      "[Vela] Warning: pipeline.json template not found. Step validation will be limited.",
      "warning"
    );
    return;
  }

  mkdirSync(join(cwd, ".vela", "templates"), { recursive: true });
  writeFileSync(dest, readFileSync(src));
}

// ─── Sprint Helper Functions ──────────────────────────────────────────────────

/** Build a compact text DAG preview for sprint slices. */
function buildSprintDagPreview(
  slices: Array<{ id: string; depends_on: string[] }>
): string | null {
  if (slices.length === 0) return null;

  // BFS level assignment
  const levels = new Map<string, number>();
  const queue: string[] = [];

  for (const s of slices) {
    if (s.depends_on.length === 0) {
      levels.set(s.id, 0);
      queue.push(s.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const lvl = levels.get(id)!;
    for (const s of slices) {
      if (s.depends_on.includes(id)) {
        const existing = levels.get(s.id) ?? -1;
        if (existing < lvl + 1) {
          levels.set(s.id, lvl + 1);
          queue.push(s.id);
        }
      }
    }
  }

  for (const s of slices) {
    if (!levels.has(s.id)) levels.set(s.id, 0);
  }

  const maxLevel = Math.max(...levels.values());
  const lines: string[] = ["DAG:"];
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const atLevel = slices.filter((s) => levels.get(s.id) === lvl);
    const row = atLevel.map((s) => `[${s.id}]`).join("  ");
    lines.push(`  ${row}`);
    if (lvl < maxLevel) lines.push("    ↓");
  }
  return lines.join("\n");
}

/** Estimate remaining sprint time based on completed slice avg. Returns string or null. */
function estimateSprintEta(plan: SprintPlan): string | null {
  const completedWithTime = plan.slices.filter(
    (s) => s.status === "done" && s.started_at && s.completed_at
  );
  if (completedWithTime.length === 0) return null;

  const totalMs = completedWithTime.reduce((sum, s) => {
    return sum + (new Date(s.completed_at!).getTime() - new Date(s.started_at!).getTime());
  }, 0);
  const avgMs = totalMs / completedWithTime.length;
  const remaining = plan.total_slices - plan.completed_slices;
  const etaMs = avgMs * remaining;

  if (etaMs < 60_000) return `~${Math.round(etaMs / 1000)}s`;
  return `~${Math.round(etaMs / 60_000)}m`;
}

// ─── Exit Gate Hint Resolver ──────────────────────────────────────────────────

/** Provide human-readable recovery hints for failed exit gates (improvement #36). */
function resolveExitGateHints(missing: string[], step: string): string[] {
  const hints: string[] = [];
  for (const m of missing) {
    if (m.includes("research.md")) hints.push("/vela dispatch --role researcher");
    else if (m.includes("plan.md")) hints.push("/vela dispatch --role planner");
    else if (m.includes("plan-check.md")) hints.push("/vela dispatch --role plan-checker");
    else if (m.includes("approval_missing:approval-execute")) hints.push("/vela dispatch --role reviewer");
    else if (m.includes("verification.md")) hints.push("/vela dispatch --role reviewer");
    else if (m.includes("diff-summary.md")) hints.push("/vela dispatch --role diff-summary");
    else if (m.includes("learning.md")) hints.push("/vela dispatch --role learning");
    else if (m === "init_complete") hints.push("/vela transition  (from init step first)");
    else if (m === "branch_created") hints.push("/vela branch --mode auto");
    else if (m === "changes_committed") hints.push("/vela commit");
    else if (m === "user_approved") hints.push("Review plan.md then /vela record pass");
    else if (m.startsWith("plan_missing_section:")) {
      const sec = m.replace("plan_missing_section:", "");
      hints.push(`Add "${sec}" section to plan.md`);
    } else if (m.startsWith("removed export:")) {
      const sym = m.replace("removed export: ", "");
      hints.push(`Update imports referencing "${sym}"`);
    }
  }
  if (hints.length === 0 && step) {
    hints.push(`/vela dispatch --role ${step}  (run agent for this step)`);
  }
  return [...new Set(hints)]; // deduplicate
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  const entries = [
    ".vela/cache/",
    ".vela/state/",
    ".vela/artifacts/",
    ".vela/sprints/",
    ".vela/tracker-signals.json",
    ".vela/write-log.jsonl",
    "*.vela-tmp",
  ];

  let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";

  const missing = entries.filter((e) => !content.includes(e));
  if (missing.length > 0) {
    const header = content.includes("# Vela") ? "" : "# Vela\n";
    const addition = (content.endsWith("\n") ? "" : "\n") + header + missing.join("\n") + "\n";
    writeFileSync(gitignorePath, content + addition);
  }
}
