/**
 * Sprint FSM test suite
 *
 * Covers: validateSprintPlan, getNextSlice, updateSliceStatus,
 *         updateSprintStatus, buildSliceContext
 *
 * Regression coverage:
 *   H-1: failed sprint can transition back to running
 *   H-2: queued slices picked up by getNextSlice
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  validateSprintPlan,
  createSprint,
  getNextSlice,
  updateSliceStatus,
  updateSprintStatus,
  buildSliceContext,
  type SprintPlan,
  type SprintSlice,
  SPRINT_VERSION,
} from "../resources/extensions/vela/sprint.ts";
import { makeTempDir } from "./helpers.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSlice(overrides: Partial<SprintSlice> = {}): SprintSlice {
  return {
    id: "slice-1",
    title: "Test slice",
    description: "A test slice",
    status: "planned",
    depends_on: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePlan(overrides: Partial<SprintPlan> = {}): SprintPlan {
  return {
    id: "sprint-test-001",
    title: "Test Sprint",
    description: "A test sprint",
    request: "implement feature X",
    status: "planned",
    version: SPRINT_VERSION,
    slices: [
      makeSlice({ id: "slice-1", title: "First slice" }),
      makeSlice({ id: "slice-2", title: "Second slice", depends_on: ["slice-1"] }),
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── validateSprintPlan ───────────────────────────────────────────────────────

describe("validateSprintPlan", () => {
  test("valid plan passes", () => {
    const result = validateSprintPlan(makePlan());
    assert.equal(result.valid, true);
    assert.ok(!result.errors || result.errors.length === 0);
  });

  test("missing title fails", () => {
    const plan = makePlan({ title: "" });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, false);
  });

  test("missing request fails", () => {
    const plan = makePlan({ request: "" });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, false);
  });

  test("empty slices array is accepted (no minimum enforced)", () => {
    // validateSprintPlan only checks that slices is an array, not that it's non-empty
    const plan = makePlan({ slices: [] });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, true);
  });

  test("duplicate slice IDs fails", () => {
    const plan = makePlan({
      slices: [
        makeSlice({ id: "slice-1" }),
        makeSlice({ id: "slice-1", title: "Duplicate" }),
      ],
    });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors?.some(e => /duplicate/i.test(e)));
  });

  test("depends_on referencing unknown slice fails", () => {
    const plan = makePlan({
      slices: [
        makeSlice({ id: "slice-1", depends_on: ["nonexistent-slice"] }),
      ],
    });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, false);
  });

  test("circular dependency detected", () => {
    const plan = makePlan({
      slices: [
        makeSlice({ id: "slice-1", depends_on: ["slice-2"] }),
        makeSlice({ id: "slice-2", depends_on: ["slice-1"] }),
      ],
    });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors?.some(e => /cycle|circular/i.test(e)));
  });

  test("invalid sprint status fails", () => {
    const plan = makePlan({ status: "invalid" as any });
    const result = validateSprintPlan(plan);
    assert.equal(result.valid, false);
  });
});

// ─── getNextSlice ─────────────────────────────────────────────────────────────

describe("getNextSlice", () => {
  test("returns 'complete' when all slices are done", () => {
    const plan = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "done" }),
        makeSlice({ id: "slice-2", status: "done", depends_on: ["slice-1"] }),
      ],
    });
    const result = getNextSlice(plan);
    assert.equal(result.action, "complete");
  });

  test("returns 'run' for first available slice with no deps", () => {
    const plan = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "planned" }),
        makeSlice({ id: "slice-2", status: "planned", depends_on: ["slice-1"] }),
      ],
    });
    const result = getNextSlice(plan);
    assert.equal(result.action, "run");
    assert.equal(result.slice?.id, "slice-1");
  });

  test("skips slice whose dependency is not done (reports wait)", () => {
    const plan = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "running" }),
        makeSlice({ id: "slice-2", status: "planned", depends_on: ["slice-1"] }),
      ],
    });
    const result = getNextSlice(plan);
    // slice-1 is running → getNextSlice reports wait
    assert.equal(result.action, "wait");
  });

  test("returns 'run' for slice whose dependency is done", () => {
    const plan = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "done" }),
        makeSlice({ id: "slice-2", status: "planned", depends_on: ["slice-1"] }),
      ],
    });
    const result = getNextSlice(plan);
    assert.equal(result.action, "run");
    assert.equal(result.slice?.id, "slice-2");
  });

  // H-2 regression: queued slices must be picked up
  test("[H-2] queued slice is picked up (regression)", () => {
    const plan = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "done" }),
        makeSlice({ id: "slice-2", status: "queued", depends_on: ["slice-1"] }),
      ],
    });
    const result = getNextSlice(plan);
    assert.equal(result.action, "run");
    assert.equal(result.slice?.id, "slice-2");
  });

  test("returns 'blocked' when all slices are pending with unmet deps (no running)", () => {
    const plan = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "planned" }),
        makeSlice({ id: "slice-2", status: "planned", depends_on: ["slice-1", "slice-3"] }),
        makeSlice({ id: "slice-3", status: "planned", depends_on: ["slice-2"] }),
      ],
    });
    // slice-1 has no deps → should be runnable, not blocked
    // Let's test a truly blocked case: all slices have circular-like unmet deps
    // Actually getNextSlice picks up slice-1 (no deps). Use 'wait' scenario instead.
    // Change: test blocked when a queued slice has unmet non-running deps
    const plan2 = makePlan({
      status: "running",
      slices: [
        makeSlice({ id: "slice-1", status: "queued", depends_on: ["slice-2"] }),
        makeSlice({ id: "slice-2", status: "queued", depends_on: ["slice-1"] }),
      ],
    });
    const result = getNextSlice(plan2);
    assert.equal(result.action, "blocked");
  });
});

// ─── updateSliceStatus ────────────────────────────────────────────────────────
// These functions load/persist from disk, so tests use a real temp dir.

describe("updateSliceStatus", () => {
  test("planned → queued is valid", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      const updated = updateSliceStatus(plan.id, "s1", { status: "queued" }, tmp.dir);
      assert.equal(updated.slices[0].status, "queued");
    } finally { tmp.cleanup(); }
  });

  test("planned → running is invalid and throws", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      assert.throws(() => {
        updateSliceStatus(plan.id, "s1", { status: "running" }, tmp.dir);
      }, /invalid transition/i);
    } finally { tmp.cleanup(); }
  });

  test("queued → running → done chain is valid", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      updateSliceStatus(plan.id, "s1", { status: "queued" }, tmp.dir);
      updateSliceStatus(plan.id, "s1", { status: "running" }, tmp.dir);
      const final = updateSliceStatus(plan.id, "s1", { status: "done" }, tmp.dir);
      assert.equal(final.slices[0].status, "done");
    } finally { tmp.cleanup(); }
  });

  test("failed → queued is valid (retry path)", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      updateSliceStatus(plan.id, "s1", { status: "queued" }, tmp.dir);
      updateSliceStatus(plan.id, "s1", { status: "running" }, tmp.dir);
      updateSliceStatus(plan.id, "s1", { status: "failed" }, tmp.dir);
      const retried = updateSliceStatus(plan.id, "s1", { status: "queued" }, tmp.dir);
      assert.equal(retried.slices[0].status, "queued");
    } finally { tmp.cleanup(); }
  });

  test("throws on unknown slice ID", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      assert.throws(() => {
        updateSliceStatus(plan.id, "nonexistent", { status: "queued" }, tmp.dir);
      });
    } finally { tmp.cleanup(); }
  });
});

// ─── updateSprintStatus ───────────────────────────────────────────────────────

describe("updateSprintStatus", () => {
  test("planned → running is valid", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      const updated = updateSprintStatus(plan.id, "running", tmp.dir);
      assert.equal(updated.status, "running");
    } finally { tmp.cleanup(); }
  });

  test("running → done is valid", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      updateSprintStatus(plan.id, "running", tmp.dir);
      const updated = updateSprintStatus(plan.id, "done", tmp.dir);
      assert.equal(updated.status, "done");
    } finally { tmp.cleanup(); }
  });

  // H-1 regression: failed sprint must be resumable
  test("[H-1] failed → running is valid (regression)", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      updateSprintStatus(plan.id, "running", tmp.dir);
      updateSprintStatus(plan.id, "failed", tmp.dir);
      const resumed = updateSprintStatus(plan.id, "running", tmp.dir);
      assert.equal(resumed.status, "running");
    } finally { tmp.cleanup(); }
  });

  test("done → running is invalid and throws", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      updateSprintStatus(plan.id, "running", tmp.dir);
      updateSprintStatus(plan.id, "done", tmp.dir);
      assert.throws(() => {
        updateSprintStatus(plan.id, "running", tmp.dir);
      }, /invalid transition/i);
    } finally { tmp.cleanup(); }
  });

  test("planned → done is invalid and throws", () => {
    const tmp = makeTempDir();
    try {
      const plan = createSprint({ title: "T", request: "R", slices: [{ id: "s1", title: "S1" }] }, tmp.dir);
      assert.throws(() => {
        updateSprintStatus(plan.id, "done", tmp.dir);
      }, /invalid transition/i);
    } finally { tmp.cleanup(); }
  });
});

// ─── buildSliceContext ────────────────────────────────────────────────────────

describe("buildSliceContext", () => {
  test("returns null when no completed dependency slices", () => {
    const plan = makePlan({
      slices: [
        makeSlice({ id: "slice-1", status: "planned" }),
        makeSlice({ id: "slice-2", status: "planned", depends_on: ["slice-1"] }),
      ],
    });
    const slice = plan.slices[1];
    const ctx = buildSliceContext(plan, slice);
    assert.equal(ctx, null);
  });

  test("includes completed dependency slice results", () => {
    // buildSliceContext only includes slices with status=done AND a .result field
    const plan = makePlan({
      slices: [
        makeSlice({ id: "slice-1", status: "done", description: "Implemented auth service", result: "Auth service implemented in src/auth/" }),
        makeSlice({ id: "slice-2", status: "planned", depends_on: ["slice-1"], description: "Add auth tests" }),
      ],
    });
    const slice = plan.slices[1];
    const ctx = buildSliceContext(plan, slice);
    assert.ok(ctx !== null);
    assert.ok(ctx!.includes("slice-1") || ctx!.includes("Auth service implemented"));
  });

  test("slice with no dependencies returns null", () => {
    const plan = makePlan({
      slices: [makeSlice({ id: "slice-1", status: "planned", depends_on: [] })],
    });
    const ctx = buildSliceContext(plan, plan.slices[0]);
    assert.equal(ctx, null);
  });
});
