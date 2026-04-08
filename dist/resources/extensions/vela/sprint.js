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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { writeJSON, slugify, formatTimestamp } from "./pipeline.js";
// ─── Constants ────────────────────────────────────────────────────────────────
export const SPRINT_VERSION = "1.0";
/** Relative (to cwd) sprint storage directory. */
const SPRINTS_DIR_REL = ".vela/sprints";
const SPRINTS_DIR = SPRINTS_DIR_REL;
// ─── FSM transition maps ──────────────────────────────────────────────────────
const SLICE_TRANSITIONS = {
    planned: new Set(["queued", "skipped"]),
    queued: new Set(["planned", "running", "skipped"]),
    running: new Set(["queued", "done", "failed", "skipped"]),
    failed: new Set(["queued"]),
};
const SPRINT_TRANSITIONS = {
    planned: new Set(["running", "cancelled"]),
    running: new Set(["done", "failed", "cancelled"]),
    failed: new Set(["running", "cancelled"]),
};
// ─── Internal helpers ─────────────────────────────────────────────────────────
/** Resolve the absolute .vela/sprints directory for a given cwd. */
function sprintsDir(cwd) {
    return join(cwd, SPRINTS_DIR_REL);
}
/** Strip runtime-only fields before persisting. */
function cleanSprint(plan) {
    const clean = { ...plan };
    delete clean._path;
    delete clean._sprintDir;
    return clean;
}
/** Persist the sprint plan to disk (strips runtime fields). */
function persistSprint(plan) {
    if (!plan._path)
        return;
    writeJSON(plan._path, cleanSprint(plan));
}
// ─── validateSprintPlan ───────────────────────────────────────────────────────
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
export function validateSprintPlan(plan) {
    const errors = [];
    // Required top-level fields
    for (const field of ["version", "id", "title", "request", "status"]) {
        if (plan[field] == null || plan[field] === "") {
            errors.push(`missing required field: ${field}`);
        }
    }
    if (!Array.isArray(plan.slices)) {
        errors.push("slices must be an array");
        return { valid: false, errors };
    }
    const knownSprintStatuses = ["planned", "running", "done", "failed", "cancelled"];
    if (!knownSprintStatuses.includes(plan.status)) {
        errors.push(`invalid sprint status: ${plan.status}`);
    }
    // Slice-level checks
    const knownSliceStatuses = ["planned", "queued", "running", "done", "failed", "skipped"];
    const sliceIds = new Set();
    for (const slice of plan.slices) {
        if (!slice.id) {
            errors.push("slice missing id");
            continue;
        }
        if (sliceIds.has(slice.id)) {
            errors.push(`duplicate slice id: ${slice.id}`);
        }
        sliceIds.add(slice.id);
        if (slice.status && !knownSliceStatuses.includes(slice.status)) {
            errors.push(`slice ${slice.id}: invalid status "${slice.status}"`);
        }
    }
    // depends_on reference validity
    for (const slice of plan.slices) {
        if (!Array.isArray(slice.depends_on))
            continue;
        for (const dep of slice.depends_on) {
            if (!sliceIds.has(dep)) {
                errors.push(`slice ${slice.id}: depends_on references unknown slice "${dep}"`);
            }
        }
    }
    // Cycle detection via Kahn's algorithm
    if (errors.length === 0) {
        const inDegree = new Map();
        const adjacency = new Map();
        const ids = [...sliceIds];
        for (const id of ids) {
            inDegree.set(id, 0);
            adjacency.set(id, []);
        }
        for (const slice of plan.slices) {
            if (!Array.isArray(slice.depends_on))
                continue;
            for (const dep of slice.depends_on) {
                adjacency.get(dep).push(slice.id);
                inDegree.set(slice.id, (inDegree.get(slice.id) ?? 0) + 1);
            }
        }
        let queue = ids.filter((id) => inDegree.get(id) === 0);
        let processed = 0;
        while (queue.length > 0) {
            processed += queue.length;
            const next = [];
            for (const id of queue) {
                for (const dependent of adjacency.get(id) ?? []) {
                    const deg = (inDegree.get(dependent) ?? 1) - 1;
                    inDegree.set(dependent, deg);
                    if (deg === 0)
                        next.push(dependent);
                }
            }
            queue = next;
        }
        if (processed < ids.length) {
            const cycled = ids.filter((id) => (inDegree.get(id) ?? 0) > 0);
            errors.push(`dependency cycle detected among slices: ${cycled.join(", ")}`);
        }
    }
    return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
// ─── createSprint ─────────────────────────────────────────────────────────────
/**
 * Create a new sprint and persist it to .vela/sprints/{ts}-{slug}/sprint-plan.json.
 *
 * Throws if required fields are missing or the resulting plan fails validation.
 */
export function createSprint(opts, cwd) {
    const { title, request, slices } = opts;
    if (!title)
        throw new Error("createSprint: title is required");
    if (!request)
        throw new Error("createSprint: request is required");
    if (!Array.isArray(slices) || slices.length === 0) {
        throw new Error("createSprint: at least one slice is required");
    }
    const ts = formatTimestamp(new Date());
    const slug = slugify(title);
    const id = `${ts}-${slug}`;
    const sprintDirPath = join(sprintsDir(cwd), id);
    const planPath = join(sprintDirPath, "sprint-plan.json");
    const now = new Date().toISOString();
    const normalizedSlices = slices.map((s) => ({
        id: s.id,
        title: s.title || s.id,
        request: s.request || s.description || "",
        status: "planned",
        depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
        artifact_dir: null,
        result: null,
        started_at: null,
        completed_at: null,
    }));
    const plan = {
        version: SPRINT_VERSION,
        id,
        title,
        request,
        status: "planned",
        created_at: now,
        updated_at: now,
        slices: normalizedSlices,
        context_passing: true,
        total_cost: 0,
        completed_slices: 0,
        total_slices: normalizedSlices.length,
    };
    const validation = validateSprintPlan(plan);
    if (!validation.valid) {
        throw new Error(`createSprint: invalid plan — ${validation.errors.join("; ")}`);
    }
    writeJSON(planPath, cleanSprint(plan));
    plan._path = planPath;
    plan._sprintDir = sprintDirPath;
    return plan;
}
// ─── loadSprint ───────────────────────────────────────────────────────────────
/**
 * Load a sprint by ID from .vela/sprints/{sprintId}/sprint-plan.json.
 *
 * Throws if the sprint does not exist or the file is unreadable.
 */
export function loadSprint(sprintId, cwd) {
    const sprintDirPath = join(sprintsDir(cwd), sprintId);
    const planPath = join(sprintDirPath, "sprint-plan.json");
    if (!existsSync(planPath)) {
        throw new Error(`loadSprint: sprint not found — ${planPath}`);
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan._path = planPath;
    plan._sprintDir = sprintDirPath;
    return plan;
}
// ─── findActiveSprint ─────────────────────────────────────────────────────────
/**
 * Scan .vela/sprints/ in reverse chronological order and return the most recent
 * sprint with status=running, or null if none exists.
 */
export function findActiveSprint(cwd) {
    const dir = sprintsDir(cwd);
    if (!existsSync(dir))
        return null;
    try {
        const allDirs = readdirSync(dir)
            .filter((d) => /^\d{8}T\d{6}-/.test(d))
            .sort()
            .reverse();
        for (const entry of allDirs) {
            const dirPath = join(dir, entry);
            try {
                if (!statSync(dirPath).isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            const planPath = join(dirPath, "sprint-plan.json");
            if (!existsSync(planPath))
                continue;
            try {
                const plan = JSON.parse(readFileSync(planPath, "utf8"));
                if (plan.status !== "running")
                    continue;
                plan._path = planPath;
                plan._sprintDir = dirPath;
                return plan;
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
// ─── listSprints ──────────────────────────────────────────────────────────────
/**
 * Return a summary list of all sprints, newest first.
 */
export function listSprints(cwd) {
    const dir = sprintsDir(cwd);
    if (!existsSync(dir))
        return [];
    const results = [];
    try {
        const allDirs = readdirSync(dir)
            .filter((d) => /^\d{8}T\d{6}-/.test(d))
            .sort()
            .reverse();
        for (const entry of allDirs) {
            const dirPath = join(dir, entry);
            try {
                if (!statSync(dirPath).isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            const planPath = join(dirPath, "sprint-plan.json");
            if (!existsSync(planPath))
                continue;
            try {
                const plan = JSON.parse(readFileSync(planPath, "utf8"));
                results.push({
                    id: plan.id,
                    title: plan.title,
                    status: plan.status,
                    created_at: plan.created_at,
                    total_slices: plan.total_slices ?? 0,
                    completed_slices: plan.completed_slices ?? 0,
                });
            }
            catch {
                continue;
            }
        }
    }
    catch {
        // directory read failure — return what we have
    }
    return results;
}
// ─── updateSliceStatus ────────────────────────────────────────────────────────
/**
 * Update a slice's status within a sprint, validating FSM transitions.
 *
 * Recomputes completed_slices count after the update.
 * Throws on invalid transitions or unknown slice IDs.
 */
export function updateSliceStatus(sprintId, sliceId, updates, cwd) {
    const plan = loadSprint(sprintId, cwd);
    const slice = plan.slices.find((s) => s.id === sliceId);
    if (!slice) {
        throw new Error(`updateSliceStatus: slice "${sliceId}" not found in sprint "${sprintId}"`);
    }
    // Validate FSM transition if status is being changed
    if (updates.status && updates.status !== slice.status) {
        const allowed = SLICE_TRANSITIONS[slice.status];
        if (!allowed || !allowed.has(updates.status)) {
            throw new Error(`updateSliceStatus: invalid transition "${slice.status}" → "${updates.status}" for slice "${sliceId}"`);
        }
    }
    // Merge allowed fields
    const mergeableFields = [
        "status",
        "artifact_dir",
        "result",
        "started_at",
        "completed_at",
    ];
    for (const field of mergeableFields) {
        if (updates[field] !== undefined) {
            slice[field] = updates[field];
        }
    }
    // Recompute completed_slices (done + skipped)
    plan.completed_slices = plan.slices.filter((s) => s.status === "done" || s.status === "skipped").length;
    plan.updated_at = new Date().toISOString();
    persistSprint(plan);
    return plan;
}
// ─── updateSprintStatus ───────────────────────────────────────────────────────
/**
 * Update a sprint's top-level status, validating FSM transitions.
 *
 * Throws on invalid transitions.
 */
export function updateSprintStatus(sprintId, status, cwd) {
    const plan = loadSprint(sprintId, cwd);
    const allowed = SPRINT_TRANSITIONS[plan.status];
    if (!allowed || !allowed.has(status)) {
        throw new Error(`updateSprintStatus: invalid transition "${plan.status}" → "${status}" for sprint "${sprintId}"`);
    }
    plan.status = status;
    plan.updated_at = new Date().toISOString();
    persistSprint(plan);
    return plan;
}
// ─── getNextSlice ─────────────────────────────────────────────────────────────
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
export function getNextSlice(plan) {
    const slices = plan.slices;
    // 1. Halt on any failure
    const failed = slices.find((s) => s.status === "failed");
    if (failed) {
        return { action: "halt", reason: `slice "${failed.id}" failed` };
    }
    // 2. All terminal
    const allTerminal = slices.every((s) => s.status === "done" || s.status === "skipped");
    if (allTerminal) {
        return { action: "complete" };
    }
    // 3. A slice is currently running
    const running = slices.find((s) => s.status === "running");
    if (running) {
        return { action: "wait", slice: running };
    }
    // 4. First planned slice whose dependencies are all satisfied
    const terminalIds = new Set(slices.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
    for (const slice of slices) {
        if (slice.status !== "queued" && slice.status !== "planned")
            continue;
        const deps = slice.depends_on ?? [];
        if (deps.every((dep) => terminalIds.has(dep))) {
            return { action: "run", slice };
        }
    }
    // 5. Blocked
    const pending = slices.filter((s) => s.status !== "done" && s.status !== "skipped");
    return {
        action: "blocked",
        reason: `${pending.length} slice(s) pending but dependencies not met`,
    };
}
// ─── buildSliceContext ────────────────────────────────────────────────────────
/**
 * Build a context string from completed dependency slices for injection into
 * the current slice's request.
 *
 * Returns null when there are no dependencies or none have results.
 */
export function buildSliceContext(plan, slice) {
    const deps = slice.depends_on ?? [];
    if (deps.length === 0)
        return null;
    const parts = [];
    for (const depId of deps) {
        const depSlice = plan.slices.find((s) => s.id === depId);
        if (!depSlice)
            continue;
        if (depSlice.status !== "done")
            continue;
        if (!depSlice.result)
            continue;
        parts.push(`### ${depSlice.title} (${depSlice.id})\n${depSlice.result}`);
    }
    return parts.length === 0 ? null : parts.join("\n\n");
}
// ─── generateSprintSummary ────────────────────────────────────────────────────
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
export function cleanupOldSprints(cwd, keepCount = 20) {
    const sprintsDir = join(cwd, SPRINTS_DIR);
    if (!existsSync(sprintsDir))
        return 0;
    let removed = 0;
    try {
        const entries = readdirSync(sprintsDir)
            .map(name => ({
            name,
            path: join(sprintsDir, name),
            mtime: (() => { try {
                return statSync(join(sprintsDir, name)).mtimeMs;
            }
            catch {
                return 0;
            } })(),
        }))
            .filter(e => { try {
            return statSync(e.path).isDirectory();
        }
        catch {
            return false;
        } })
            .sort((a, b) => b.mtime - a.mtime);
        const toRemove = entries.slice(keepCount);
        for (const entry of toRemove) {
            try {
                rmSync(entry.path, { recursive: true, force: true });
                removed++;
            }
            catch { /* skip */ }
        }
    }
    catch { /* skip */ }
    return removed;
}
export function generateSprintSummary(plan, cwd) {
    const now = new Date().toISOString();
    // Header
    let md = `# Sprint Summary\n\n`;
    md += `**Title:** ${plan.title}\n`;
    md += `**Request:** ${plan.request}\n`;
    md += `**Created:** ${plan.created_at}\n`;
    md += `**Completed:** ${now}\n`;
    md += `**Status:** ${plan.status}\n\n`;
    // Per-slice table
    md += `## Slice Results\n\n`;
    md += `| ID | Title | Status | Duration | Result |\n`;
    md += `|----|-------|--------|----------|--------|\n`;
    let doneCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    for (const slice of plan.slices) {
        const statusLabel = slice.status === "done"
            ? "done"
            : slice.status === "failed"
                ? "failed"
                : slice.status === "skipped"
                    ? "skipped"
                    : slice.status;
        // Duration from timestamps
        let duration = "-";
        if (slice.started_at && slice.completed_at) {
            const ms = new Date(slice.completed_at).getTime() - new Date(slice.started_at).getTime();
            if (ms >= 0)
                duration = `${(ms / 1000).toFixed(1)}s`;
        }
        // Result snippet (truncated, pipe-escaped)
        let resultSnippet = slice.result ?? "-";
        if (resultSnippet.length > 60)
            resultSnippet = resultSnippet.substring(0, 57) + "...";
        resultSnippet = resultSnippet.replace(/\|/g, "\\|");
        md += `| ${slice.id} | ${slice.title} | ${statusLabel} | ${duration} | ${resultSnippet} |\n`;
        if (slice.status === "done")
            doneCount++;
        else if (slice.status === "failed")
            failedCount++;
        else if (slice.status === "skipped")
            skippedCount++;
    }
    // Stats
    md += `\n## Stats\n\n`;
    md += `- **Total slices:** ${plan.total_slices}\n`;
    md += `- **Completed:** ${doneCount}\n`;
    md += `- **Failed:** ${failedCount}\n`;
    md += `- **Skipped:** ${skippedCount}\n`;
    // Write file
    const sprintDirPath = join(sprintsDir(cwd), plan.id);
    if (!existsSync(sprintDirPath)) {
        mkdirSync(sprintDirPath, { recursive: true });
    }
    const summaryPath = join(sprintDirPath, "sprint-summary.md");
    writeFileSync(summaryPath, md, "utf8");
    return summaryPath;
}
//# sourceMappingURL=sprint.js.map