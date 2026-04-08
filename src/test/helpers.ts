/**
 * Shared test helpers — temp dirs, state/def fixtures
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineState, PipelineDef } from "../resources/extensions/vela/pipeline.ts";

// ─── Temp directory ────────────────────────────────────────────────────────────

export interface TempDir {
  dir: string;
  cleanup: () => void;
}

export function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "vela-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── Pipeline State fixture ────────────────────────────────────────────────────

export function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    pipeline_type: "standard",
    status: "active",
    current_step: "init",
    current_step_index: 0,
    request: "test request",
    artifact_dir: "/tmp/vela-test-artifact",
    completed_steps: [],
    revisions: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Pipeline Definition fixture ─────────────────────────────────────────────

export function makeDef(): PipelineDef {
  return {
    version: "1.2",
    pipelines: {
      standard: {
        description: "Full pipeline",
        steps: [
          {
            id: "init",
            name: "Initialize",
            actor: "pm",
            mode: "read",
            entry_gate: [],
            exit_gate: ["artifact_dir_created"],
            artifacts: [],
            max_revisions: 1,
          },
          {
            id: "research",
            name: "Research",
            actor: "agent",
            mode: "rw-artifact",
            entry_gate: ["init_complete"],
            exit_gate: ["research_md_exists"],
            artifacts: ["research.md"],
            max_revisions: 3,
          },
          {
            id: "execute",
            name: "Execute",
            actor: "agent",
            mode: "readwrite",
            entry_gate: [],
            exit_gate: [],
            artifacts: [],
            max_revisions: 5,
          },
          {
            id: "verify",
            name: "Verify",
            actor: "agent",
            mode: "read",
            entry_gate: [],
            exit_gate: ["verification_md_exists"],
            artifacts: ["verification.md"],
            max_revisions: 3,
          },
          {
            id: "commit",
            name: "Commit",
            actor: "pm",
            mode: "readwrite",
            entry_gate: [],
            exit_gate: ["changes_committed"],
            artifacts: [],
            max_revisions: 1,
          },
          {
            id: "finalize",
            name: "Finalize",
            actor: "agent",
            mode: "readwrite",
            entry_gate: [],
            exit_gate: ["report_md_exists"],
            artifacts: ["report.md"],
            max_revisions: 1,
          },
        ],
      },
      trivial: {
        description: "Small pipeline",
        steps: [
          {
            id: "init",
            name: "Initialize",
            actor: "pm",
            mode: "read",
            entry_gate: [],
            exit_gate: ["artifact_dir_created"],
            artifacts: [],
            max_revisions: 1,
          },
          {
            id: "execute",
            name: "Execute",
            actor: "agent",
            mode: "readwrite",
            entry_gate: [],
            exit_gate: [],
            artifacts: [],
            max_revisions: 5,
          },
        ],
      },
    },
    modes: {
      read: { allowed_tools: [], blocked_tools: [], bash_policy: "safe-read-only" },
      write: { allowed_tools: [], blocked_tools: [], bash_policy: "blocked" },
      readwrite: { allowed_tools: [], blocked_tools: [], bash_policy: "all" },
      "rw-artifact": { allowed_tools: [], blocked_tools: ["Edit", "NotebookEdit"], bash_policy: "safe-read-only", artifact_write_only: true },
    },
  };
}

// ─── Artifact dir helpers ─────────────────────────────────────────────────────

/** Create a minimal artifact dir with pipeline-state.json wired up */
export function makeArtifactDir(baseDir: string, stateOverrides: Partial<PipelineState> = {}): {
  artifactDir: string;
  statePath: string;
  state: PipelineState;
} {
  const artifactDir = join(baseDir, ".vela", "artifacts", "20260101T000000-test");
  mkdirSync(artifactDir, { recursive: true });

  const statePath = join(artifactDir, "pipeline-state.json");
  const state = makeState({
    artifact_dir: artifactDir,
    _path: statePath,
    _artifactDir: artifactDir,
    ...stateOverrides,
  });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { artifactDir, statePath, state };
}
