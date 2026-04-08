/**
 * Vela Sprint Orchestration — Phase 6
 *
 * TypeScript port of scripts/shared/sprint-manager.js +
 * sprint-orchestration logic from scripts/cli/vela-sprint.js.
 *
 * Manages sprint lifecycle: create, load, list, slice/sprint FSM transitions,
 * dependency-aware queue, context passing, and summary generation.
 *
 * Uses writeJSON / slugify / formatTimestamp from pipeline.ts.
 * Does NOT import from @gsd/pi-coding-agent — only Node.js built-ins + local files.
 */
export declare const SPRINT_VERSION = "1.0";
export type SprintStatus = "planned" | "running" | "done" | "failed" | "cancelled";
export type SliceStatus = "planned" | "queued" | "running" | "done" | "failed" | "skipped";
export interface SprintSlice {
    id: string;
    title: string;
    request: string;
    status: SliceStatus;
    depends_on: string[];
    artifact_dir: string | null;
    result: string | null;
    started_at: string | null;
    completed_at: string | null;
}
export interface SprintPlan {
    version: string;
    id: string;
    title: string;
    request: string;
    status: SprintStatus;
    created_at: string;
    updated_at: string;
    slices: SprintSlice[];
    context_passing: boolean;
    total_cost: number;
    completed_slices: number;
    total_slices: number;
    _path?: string;
    _sprintDir?: string;
}
export interface SliceNextAction {
    action: "run" | "complete" | "halt" | "wait" | "blocked";
    slice?: SprintSlice;
    reason?: string;
}
/**
 * Validate a sprint plan object.
 *
 * Checks:
 *   - Required top-level fields (version, id, title, request, status, slices[])
 *   - Sprint status is a known value
 *   - Slice ID uniqueness
 *   - Slice status values are known
 *   - depends_on references point to existing slice IDs
 *   - No dependency cycles (Kahn's algorithm)
 */
export declare function validateSprintPlan(plan: SprintPlan): {
    valid: boolean;
    errors?: string[];
};
/**
 * Create a new sprint and persist it to .vela/sprints/{ts}-{slug}/sprint-plan.json.
 *
 * Throws if required fields are missing or the resulting plan fails validation.
 */
export declare function createSprint(opts: {
    title: string;
    request: string;
    slices: Array<{
        id: string;
        title: string;
        description?: string;
        depends_on?: string[];
    }>;
}, cwd: string): SprintPlan;
/**
 * Load a sprint by ID from .vela/sprints/{sprintId}/sprint-plan.json.
 *
 * Throws if the sprint does not exist or the file is unreadable.
 */
export declare function loadSprint(sprintId: string, cwd: string): SprintPlan;
/**
 * Scan .vela/sprints/ in reverse chronological order and return the most recent
 * sprint with status=running, or null if none exists.
 */
export declare function findActiveSprint(cwd: string): SprintPlan | null;
/**
 * Scan .vela/sprints/ in reverse chronological order and return the most recent
 * sprint that can be resumed: prefers status=running, falls back to status=failed.
 * Returns null if no resumable sprint exists.
 */
export declare function findResumableSprint(cwd: string): SprintPlan | null;
/**
 * Return a summary list of all sprints, newest first.
 */
export declare function listSprints(cwd: string): Array<{
    id: string;
    title: string;
    status: string;
    created_at: string;
    total_slices: number;
    completed_slices: number;
}>;
/**
 * Update a slice's status within a sprint, validating FSM transitions.
 *
 * Recomputes completed_slices count after the update.
 * Throws on invalid transitions or unknown slice IDs.
 */
export declare function updateSliceStatus(sprintId: string, sliceId: string, updates: Partial<Pick<SprintSlice, "status" | "artifact_dir" | "result" | "started_at" | "completed_at">>, cwd: string): SprintPlan;
/**
 * Update a sprint's top-level status, validating FSM transitions.
 *
 * Throws on invalid transitions.
 */
export declare function updateSprintStatus(sprintId: string, status: SprintStatus, cwd: string): SprintPlan;
/**
 * Pure function — determines the next action for a sprint.
 *
 * Decision order:
 *   1. Any failed slice  → halt
 *   2. All slices done/skipped → complete
 *   3. A slice is running → wait
 *   4. A planned slice with all deps satisfied → run
 *   5. Slices remain but no deps satisfied → blocked
 */
export declare function getNextSlice(plan: SprintPlan): SliceNextAction;
/**
 * Build a context string from completed dependency slices for injection into
 * the current slice's request.
 *
 * Returns null when there are no dependencies or none have results.
 */
export declare function buildSliceContext(plan: SprintPlan, slice: SprintSlice): string | null;
/**
 * Write a markdown summary of the sprint to .vela/sprints/{id}/sprint-summary.md.
 *
 * Produces: header (title, request, timing), per-slice table with
 * status / duration / result snippet, and overall stats.
 *
 * Returns the absolute path to the written file.
 */
/**
 * Remove sprint directories older than keepDays, keeping the N most recent.
 */
export declare function cleanupOldSprints(cwd: string, keepCount?: number): number;
export declare function generateSprintSummary(plan: SprintPlan, cwd: string): string;
//# sourceMappingURL=sprint.d.ts.map