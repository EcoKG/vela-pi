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
import { execSync } from "node:child_process";
export declare const PROTECTED_BRANCHES: string[];
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
    team?: {
        worker_role?: string;
        reviewer_role?: string;
        approver?: string;
    };
    git?: Record<string, unknown>;
}
export interface PipelineDef {
    version: string;
    pipelines: Record<string, {
        description: string;
        steps: PipelineStep[];
        inherits?: string;
        steps_only?: string[];
        overrides?: Record<string, Partial<PipelineStep>>;
    }>;
    modes: Record<string, {
        allowed_tools: string[];
        blocked_tools: string[];
        bash_policy: string;
        treenode_cache?: boolean;
        artifact_write_only?: boolean;
    }>;
    git?: {
        commit?: {
            type_map?: Record<string, string>;
        };
        gitignore_entries?: string[];
    };
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
    pipeline_id?: string;
    pipeline_type: string;
    version?: string;
    status: "active" | "completed" | "cancelled" | "failed";
    current_step: string;
    current_step_index?: number;
    request: string;
    task_type?: string;
    type?: string;
    scale?: string;
    steps?: string[];
    completed_steps?: string[];
    revisions?: Record<string, number>;
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
    artifact_dir: string;
    auto?: boolean;
    auto_reject_count?: number;
    sub_phases?: Record<string, SubPhaseState>;
    sub_phase?: string;
    created_at: string;
    updated_at: string;
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
/**
 * Scan .vela/artifacts/ for the most-recent active pipeline-state.json.
 * Populates _path and _artifactDir runtime fields.
 */
export declare function findActivePipelineState(cwd: string): PipelineState | null;
export declare function loadPipelineDefinition(cwd: string, extensionDir?: string): PipelineDef | null;
export declare function resolveSteps(def: PipelineDef, pipelineType: string): PipelineStep[];
export declare function getCurrentStep(state: PipelineState, def: PipelineDef): PipelineStep | null;
export declare function getCurrentMode(state: PipelineState | null, def: PipelineDef | null): PipelineMode;
export declare function checkExitGate(stepDef: PipelineStep, state: PipelineState): ExitGateResult;
/** Advance the pipeline to the next step (mutates + persists state). */
export declare function transitionPipeline(state: PipelineState, def: PipelineDef): TransitionResult;
/** Record a step verdict (pass/fail/reject). Increments revision counter. */
export declare function recordStep(state: PipelineState, verdict: string, summary?: string): RecordResult;
/** Advance the TDD sub-phase for the current step. */
export declare function subTransitionPipeline(state: PipelineState): {
    ok: boolean;
    completed?: boolean;
    previous_phase?: string;
    current_phase?: string;
    remaining?: string[];
    error?: string;
};
export declare function snapshotGitState(cwd: string): GitState;
/** Create (or reuse) a pipeline feature branch. Returns { ok, branch, action, error? }. */
export declare function createPipelineBranch(cwd: string, state: PipelineState, mode?: "auto" | "prompt" | "none"): {
    ok: boolean;
    action: string;
    branch?: string;
    suggested_command?: string;
    error?: string;
};
/** Stage and commit all changes. Returns { ok, hash, commit_message, action, error? }. */
export declare function commitPipeline(cwd: string, state: PipelineState, def: PipelineDef | null, messageOverride?: string): {
    ok: boolean;
    action?: string;
    hash?: string;
    commit_message?: string;
    error?: string;
};
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
export declare function listPipelineHistory(cwd: string): PipelineHistoryEntry[];
/** Remove cancelled/completed artifact dirs older than `hoursOld` hours. */
export declare function cleanupCancelledArtifacts(cwd: string, hoursOld?: number): number;
/**
 * Mark pipelines that have been active for more than 48h as cancelled.
 * Returns the number of pipelines marked as stale.
 */
export declare function cleanupStalePipelines(cwd: string, hoursOld?: number): number;
/** Atomic JSON write via tmp → rename. */
export declare function writeJSON(filePath: string, data: unknown): void;
/** Generate a URL-safe slug from a string (max 40 chars). */
export declare function slugify(text: string): string;
/** Format a Date as YYYYMMDDTHHMMSS. */
export declare function formatTimestamp(d?: Date): string;
export { execSync };
//# sourceMappingURL=pipeline.d.ts.map