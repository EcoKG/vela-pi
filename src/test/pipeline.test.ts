/**
 * Pipeline state machine test suite
 *
 * Covers: slugify, formatTimestamp, resolveSteps, getCurrentMode,
 *         checkExitGate, transitionPipeline, recordStep, subTransitionPipeline
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  slugify,
  formatTimestamp,
  resolveSteps,
  getCurrentMode,
  checkExitGate,
  transitionPipeline,
  recordStep,
  subTransitionPipeline,
} from "../resources/extensions/vela/pipeline.ts";

import { makeTempDir, makeState, makeArtifactDir, makeDef } from "./helpers.ts";

// ─── slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  test("strips special characters", () => {
    assert.equal(slugify("Add user auth (OAuth2)!"), "add-user-auth-oauth2");
  });

  test("caps at 40 characters", () => {
    const long = "a".repeat(50);
    assert.equal(slugify(long).length, 40);
  });

  test("trims trailing hyphens", () => {
    const result = slugify("test---");
    assert.ok(!result.endsWith("-"));
  });

  test("empty string returns empty", () => {
    assert.equal(slugify(""), "");
  });
});

// ─── formatTimestamp ─────────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  test("returns YYYYMMDDTHHMMSS format", () => {
    const d = new Date("2026-04-08T14:05:09Z");
    const ts = formatTimestamp(d);
    assert.match(ts, /^\d{8}T\d{6}$/);
  });

  test("pads single-digit month and day", () => {
    const d = new Date("2026-01-05T03:07:09Z");
    const ts = formatTimestamp(d);
    assert.equal(ts.slice(0, 8), "20260105");
  });

  test("no argument uses current date (smoke test)", () => {
    const ts = formatTimestamp();
    assert.match(ts, /^\d{8}T\d{6}$/);
  });
});

// ─── resolveSteps ─────────────────────────────────────────────────────────────

describe("resolveSteps", () => {
  const def = makeDef();

  test("returns steps for standard pipeline", () => {
    const steps = resolveSteps(def, "standard");
    assert.ok(steps.length > 0);
    assert.equal(steps[0].id, "init");
  });

  test("returns steps for trivial pipeline", () => {
    const steps = resolveSteps(def, "trivial");
    assert.ok(steps.length > 0);
    assert.equal(steps[0].id, "init");
  });

  test("returns empty array for unknown pipeline", () => {
    const steps = resolveSteps(def, "nonexistent");
    assert.deepEqual(steps, []);
  });

  test("inherits steps from parent when steps_only is set", () => {
    const defWithInheritance: typeof def = {
      ...def,
      pipelines: {
        ...def.pipelines,
        docs: {
          description: "Docs-only",
          inherits: "standard",
          steps_only: ["init", "execute"],
          steps: [],
        },
      },
    };
    const steps = resolveSteps(defWithInheritance, "docs");
    assert.equal(steps.length, 2);
    assert.equal(steps[0].id, "init");
    assert.equal(steps[1].id, "execute");
  });
});

// ─── getCurrentMode ───────────────────────────────────────────────────────────

describe("getCurrentMode", () => {
  const def = makeDef();

  test("returns 'readwrite' when state is null", () => {
    assert.equal(getCurrentMode(null, def), "readwrite");
  });

  test("returns 'readwrite' when def is null", () => {
    const state = makeState({ current_step: "init" });
    assert.equal(getCurrentMode(state, null), "readwrite");
  });

  test("returns correct mode for init step (read)", () => {
    const state = makeState({ current_step: "init" });
    assert.equal(getCurrentMode(state, def), "read");
  });

  test("returns correct mode for execute step (readwrite)", () => {
    const state = makeState({ current_step: "execute" });
    assert.equal(getCurrentMode(state, def), "readwrite");
  });

  test("returns correct mode for research step (rw-artifact)", () => {
    const state = makeState({ current_step: "research" });
    assert.equal(getCurrentMode(state, def), "rw-artifact");
  });
});

// ─── checkExitGate ───────────────────────────────────────────────────────────

describe("checkExitGate", () => {
  test("step with empty exit_gate always passes", () => {
    const def = makeDef();
    const step = def.pipelines.standard.steps.find(s => s.id === "execute")!;
    const state = makeState({ current_step: "execute" });
    const result = checkExitGate(step, state);
    assert.equal(result.passed, true);
    assert.deepEqual(result.missing, []);
  });

  test("artifact_dir_created: fails when dir missing", () => {
    const step = {
      id: "init", name: "Init", actor: "pm" as const, mode: "read" as const,
      entry_gate: [], exit_gate: ["artifact_dir_created"], artifacts: [], max_revisions: 1,
    };
    const state = makeState({
      current_step: "init",
      _artifactDir: "/nonexistent/path/that/does/not/exist",
    });
    const result = checkExitGate(step, state);
    assert.equal(result.passed, false);
    assert.ok(result.missing.includes("artifact_dir_created"));
  });

  test("artifact_dir_created: passes when dir exists", () => {
    const tmp = makeTempDir();
    try {
      const { artifactDir, state } = makeArtifactDir(tmp.dir, { current_step: "init" });
      const step = {
        id: "init", name: "Init", actor: "pm" as const, mode: "read" as const,
        entry_gate: [], exit_gate: ["artifact_dir_created"], artifacts: [], max_revisions: 1,
      };
      const result = checkExitGate(step, state);
      assert.equal(result.passed, true);
    } finally {
      tmp.cleanup();
    }
  });

  test("research_md_exists: fails when research.md missing", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, { current_step: "research" });
      const step = {
        id: "research", name: "Research", actor: "agent" as const, mode: "rw-artifact" as const,
        entry_gate: [], exit_gate: ["research_md_exists"], artifacts: [], max_revisions: 3,
      };
      const result = checkExitGate(step, state);
      assert.equal(result.passed, false);
      assert.ok(result.missing.includes("research_md_exists"));
    } finally {
      tmp.cleanup();
    }
  });

  test("research_md_exists: passes when research.md present", () => {
    const tmp = makeTempDir();
    try {
      const { artifactDir, state } = makeArtifactDir(tmp.dir, { current_step: "research" });
      writeFileSync(join(artifactDir, "research.md"), "# Research\nDone.");
      const step = {
        id: "research", name: "Research", actor: "agent" as const, mode: "rw-artifact" as const,
        entry_gate: [], exit_gate: ["research_md_exists"], artifacts: [], max_revisions: 3,
      };
      const result = checkExitGate(step, state);
      assert.equal(result.passed, true);
    } finally {
      tmp.cleanup();
    }
  });

  test("init_complete: fails when init not in completed_steps", () => {
    const step = {
      id: "research", name: "Research", actor: "agent" as const, mode: "rw-artifact" as const,
      entry_gate: [], exit_gate: ["init_complete"], artifacts: [], max_revisions: 3,
    };
    const state = makeState({ current_step: "research", completed_steps: [] });
    const result = checkExitGate(step, state);
    assert.equal(result.passed, false);
  });

  test("init_complete: passes when init is in completed_steps", () => {
    const step = {
      id: "research", name: "Research", actor: "agent" as const, mode: "rw-artifact" as const,
      entry_gate: [], exit_gate: ["init_complete"], artifacts: [], max_revisions: 3,
    };
    const state = makeState({ current_step: "research", completed_steps: ["init"] });
    const result = checkExitGate(step, state);
    assert.equal(result.passed, true);
  });
});

// ─── recordStep ───────────────────────────────────────────────────────────────

describe("recordStep", () => {
  test("pass verdict increments revision counter", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, { current_step: "execute" });
      const result = recordStep(state, "pass");
      assert.equal(result.ok, true);
      assert.equal(result.verdict, "pass");
      assert.equal(result.revision, 1);
    } finally {
      tmp.cleanup();
    }
  });

  test("fail verdict increments revision counter", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, { current_step: "execute" });
      const result = recordStep(state, "fail");
      assert.equal(result.ok, true);
      assert.equal(result.verdict, "fail");
    } finally {
      tmp.cleanup();
    }
  });

  test("invalid verdict returns error", () => {
    const state = makeState({ current_step: "execute" });
    const result = recordStep(state, "invalid");
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  test("auto mode disabled after 2 consecutive rejects", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, { current_step: "execute", auto: true });
      recordStep(state, "reject");
      const result = recordStep(state, "reject");
      assert.equal(state.auto, false);
      assert.equal(result.auto_disabled, true);
    } finally {
      tmp.cleanup();
    }
  });

  test("auto reject count resets on pass", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, { current_step: "execute", auto: true });
      recordStep(state, "reject");
      recordStep(state, "pass");
      assert.equal(state.auto_reject_count, 0);
      assert.equal(state.auto, true);
    } finally {
      tmp.cleanup();
    }
  });
});

// ─── transitionPipeline ───────────────────────────────────────────────────────

describe("transitionPipeline", () => {
  const def = makeDef();

  test("advances to next step when exit gate passes", () => {
    const tmp = makeTempDir();
    try {
      const { artifactDir, state } = makeArtifactDir(tmp.dir, {
        current_step: "init",
        current_step_index: 0,
        pipeline_type: "standard",
        completed_steps: [],
      });
      // Satisfy artifact_dir_created gate (dir already exists)
      const result = transitionPipeline(state, def);
      assert.equal(result.ok, true);
      assert.equal(result.completed, false);
      assert.equal(result.previous_step, "init");
      assert.equal(result.current_step, "research");
      assert.ok(state.completed_steps!.includes("init"));
    } finally {
      tmp.cleanup();
    }
  });

  test("marks pipeline completed on last step", () => {
    const tmp = makeTempDir();
    try {
      const trivialDef = makeDef();
      const { state } = makeArtifactDir(tmp.dir, {
        current_step: "execute",
        current_step_index: 1,
        pipeline_type: "trivial",
        completed_steps: ["init"],
      });
      const result = transitionPipeline(state, trivialDef);
      assert.equal(result.ok, true);
      assert.equal(result.completed, true);
      assert.equal(state.status, "completed");
    } finally {
      tmp.cleanup();
    }
  });

  test("fails when exit gate not met", () => {
    const tmp = makeTempDir();
    try {
      // research step requires research_md_exists — file not present
      const { state } = makeArtifactDir(tmp.dir, {
        current_step: "research",
        current_step_index: 1,
        pipeline_type: "standard",
        completed_steps: ["init"],
      });
      const result = transitionPipeline(state, def);
      assert.equal(result.ok, false);
      assert.ok(result.error);
      assert.ok(result.missing && result.missing.length > 0);
    } finally {
      tmp.cleanup();
    }
  });

  test("returns error for unknown current step", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, {
        current_step: "nonexistent-step",
        pipeline_type: "standard",
      });
      const result = transitionPipeline(state, def);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes("not found"));
    } finally {
      tmp.cleanup();
    }
  });
});

// ─── subTransitionPipeline ────────────────────────────────────────────────────

describe("subTransitionPipeline", () => {
  test("advances to next sub-phase", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, {
        current_step: "execute",
        sub_phases: {
          execute: {
            phases: ["red", "green", "refactor"],
            current_index: 0,
            current_phase: "red",
            completed_phases: [],
          },
        },
      });
      const result = subTransitionPipeline(state);
      assert.equal(result.ok, true);
      assert.equal(result.completed, false);
      assert.equal(result.previous_phase, "red");
      assert.equal(result.current_phase, "green");
    } finally {
      tmp.cleanup();
    }
  });

  test("returns completed on last sub-phase", () => {
    const tmp = makeTempDir();
    try {
      const { state } = makeArtifactDir(tmp.dir, {
        current_step: "execute",
        sub_phases: {
          execute: {
            phases: ["red", "green"],
            current_index: 1,
            current_phase: "green",
            completed_phases: ["red"],
          },
        },
      });
      const result = subTransitionPipeline(state);
      assert.equal(result.ok, true);
      assert.equal(result.completed, true);
    } finally {
      tmp.cleanup();
    }
  });

  test("returns error when step has no sub-phases", () => {
    const state = makeState({ current_step: "execute" });
    const result = subTransitionPipeline(state);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});
