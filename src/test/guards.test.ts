/**
 * Guards test suite — VK-01 through VK-08, VG-00 through VG-15
 *
 * Covers every gate rule in checkToolCall.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkToolCall } from "../resources/extensions/vela/guards.ts";
import { makeTempDir, makeState, makeArtifactDir } from "./helpers.ts";

// ─── VK-01 / VK-02: Bash in read mode ────────────────────────────────────────

describe("VK-01/VK-02: Bash — read mode", () => {
  test("safe read commands pass", () => {
    for (const cmd of ["ls -la", "cat README.md", "grep -r foo src/", "git status"]) {
      const r = checkToolCall("Bash", { command: cmd }, "read");
      assert.equal(r.blocked, false, `expected ${cmd} to pass`);
    }
  });

  test("write redirect blocked", () => {
    const r = checkToolCall("Bash", { command: "echo hello > out.txt" }, "read");
    assert.equal(r.blocked, true);
  });

  test("mkdir blocked", () => {
    const r = checkToolCall("Bash", { command: "mkdir -p new-dir" }, "read");
    assert.equal(r.blocked, true);
  });

  test("curl (not in safe-read list) blocked with VK-02", () => {
    const r = checkToolCall("Bash", { command: "curl https://example.com" }, "read");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-02");
  });

  test("npm install blocked in read mode", () => {
    const r = checkToolCall("Bash", { command: "npm install" }, "read");
    assert.equal(r.blocked, true);
  });
});

// ─── VK-01: Bash in write mode ───────────────────────────────────────────────

describe("VK-01: Bash — write mode", () => {
  test("any bash is blocked in write mode", () => {
    const r = checkToolCall("Bash", { command: "ls -la" }, "write");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-01");
  });
});

// ─── VK-08: Chain operators ───────────────────────────────────────────────────

describe("VK-08: Chain operators", () => {
  test("all-safe chain allowed in read mode", () => {
    const r = checkToolCall("Bash", { command: "ls -la && cat README.md" }, "read");
    assert.equal(r.blocked, false);
  });

  test("unsafe chain blocked in read mode", () => {
    const r = checkToolCall("Bash", { command: "ls && npm install" }, "read");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-08");
  });

  test("chain allowed freely in readwrite mode", () => {
    const r = checkToolCall("Bash", { command: "npm install && npm run build" }, "readwrite");
    assert.equal(r.blocked, false);
  });
});

// ─── VK-03: Write tools in read mode ─────────────────────────────────────────

describe("VK-03: Write tools — read mode", () => {
  test("Edit blocked in read mode", () => {
    const r = checkToolCall("Edit", { file_path: "/src/foo.ts", new_string: "x", old_string: "y" }, "read");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-03");
  });

  test("Write blocked in read mode", () => {
    const r = checkToolCall("Write", { file_path: "/src/foo.ts", content: "x" }, "read");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-03");
  });

  test("NotebookEdit blocked in read mode", () => {
    const r = checkToolCall("NotebookEdit", { file_path: "/nb.ipynb" }, "read");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-03");
  });
});

// ─── VK-04: rw-artifact mode ─────────────────────────────────────────────────

describe("VK-04: rw-artifact mode", () => {
  test("Edit blocked in rw-artifact", () => {
    const r = checkToolCall("Edit", { file_path: "/project/.vela/artifacts/run/out.md", old_string: "a", new_string: "b" }, "rw-artifact");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-04");
  });

  test("Write to non-artifact path blocked", () => {
    const r = checkToolCall("Write", { file_path: "/project/src/main.ts", content: "x" }, "rw-artifact");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-04");
  });

  test("Write to artifact path allowed", () => {
    const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/run/research.md", content: "x" }, "rw-artifact");
    assert.equal(r.blocked, false);
  });
});

// ─── VK-05: Sensitive files ───────────────────────────────────────────────────

describe("VK-05: Sensitive file protection", () => {
  test(".env write blocked", () => {
    const r = checkToolCall("Write", { file_path: "/project/.env", content: "SECRET=x" }, "readwrite");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-05");
  });

  test("id_rsa write blocked", () => {
    const r = checkToolCall("Write", { file_path: "/home/user/.ssh/id_rsa", content: "..." }, "readwrite");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-05");
  });

  test("credentials.json write blocked", () => {
    const r = checkToolCall("Write", { file_path: "/project/credentials.json", content: "{}" }, "readwrite");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-05");
  });

  test("normal file write allowed", () => {
    const r = checkToolCall("Write", { file_path: "/project/src/app.ts", content: "export {}" }, "readwrite");
    assert.equal(r.blocked, false);
  });
});

// ─── VK-06: Secret detection ─────────────────────────────────────────────────

describe("VK-06: Secret detection", () => {
  test("AWS access key in content blocked", () => {
    const r = checkToolCall("Write", { file_path: "/project/config.ts", content: "const key = 'AKIAIOSFODNN7EXAMPLE';" }, "readwrite");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-06");
  });

  test("Anthropic key in Bash command blocked", () => {
    const r = checkToolCall("Bash", { command: `curl -H "x-api-key: sk-ant-${"a".repeat(95)}" https://api.anthropic.com` }, "readwrite");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-06");
  });

  test("GitHub PAT in new_string blocked", () => {
    const content = `token: ghp_${"A".repeat(36)}`;
    const r = checkToolCall("Edit", { file_path: "/project/config.ts", old_string: "token: ''", new_string: content }, "readwrite");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VK-06");
  });

  test("normal content allowed", () => {
    const r = checkToolCall("Write", { file_path: "/project/src/util.ts", content: "export const add = (a: number, b: number) => a + b;" }, "readwrite");
    assert.equal(r.blocked, false);
  });
});

// ─── VG-00: Task management tools ────────────────────────────────────────────

describe("VG-00: Task management tools blocked during pipeline", () => {
  const state = makeState({ current_step: "execute" });

  for (const tool of ["TaskCreate", "TaskUpdate", "TaskList", "TodoWrite"]) {
    test(`${tool} blocked`, () => {
      const r = checkToolCall(tool, {}, "readwrite", state);
      assert.equal(r.blocked, true);
      assert.equal(r.code, "VG-00");
    });
  }
});

// ─── VG-02: Source writes before execute ────────────────────────────────────

describe("VG-02: Source code modification blocked pre-execute", () => {
  // Agent steps (not PM steps) where VG-02 fires; PM steps (init, branch) hit VK-07 first
  const agentPreExecuteSteps = ["research", "plan", "plan-check", "checkpoint"];

  for (const step of agentPreExecuteSteps) {
    test(`Write to src/ blocked in step "${step}"`, () => {
      const state = makeState({ current_step: step });
      const r = checkToolCall("Write", { file_path: "/project/src/app.ts", content: "x" }, "readwrite", state);
      assert.equal(r.blocked, true);
      assert.equal(r.code, "VG-02");
    });
  }

  test("Write to .vela/ allowed in pre-execute step", () => {
    const state = makeState({ current_step: "init" });
    const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/run/meta.json", content: "{}" }, "readwrite", state);
    assert.equal(r.blocked, false);
  });
});

// ─── VG-04: report.md requires verification.md ──────────────────────────────

describe("VG-04: report.md blocked without verification.md", () => {
  test("report.md blocked when verification.md missing", () => {
    const tmp = makeTempDir();
    try {
      const { artifactDir, state } = makeArtifactDir(tmp.dir, { current_step: "finalize" });
      const r = checkToolCall("Write", { file_path: join(artifactDir, "report.md"), content: "done" }, "readwrite", state);
      assert.equal(r.blocked, true);
      assert.equal(r.code, "VG-04");
    } finally {
      tmp.cleanup();
    }
  });

  test("report.md allowed when verification.md present", () => {
    const tmp = makeTempDir();
    try {
      const { artifactDir, state } = makeArtifactDir(tmp.dir, { current_step: "finalize" });
      writeFileSync(join(artifactDir, "verification.md"), "# Verify\nOK");
      const r = checkToolCall("Write", { file_path: join(artifactDir, "report.md"), content: "done" }, "readwrite", state);
      assert.equal(r.blocked, false);
    } finally {
      tmp.cleanup();
    }
  });
});

// ─── VG-05: pipeline-state.json protection ───────────────────────────────────

describe("VG-05: Direct pipeline-state.json write blocked", () => {
  test("Write to pipeline-state.json blocked", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/run/pipeline-state.json", content: "{}" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-05");
  });
});

// ─── VG-07: git commit step restrictions ─────────────────────────────────────

describe("VG-07: git commit step restrictions", () => {
  test("git commit blocked in research step", () => {
    const state = makeState({ current_step: "research" });
    const r = checkToolCall("Bash", { command: "git commit -m 'wip'" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-07");
  });

  test("git commit allowed in commit step", () => {
    const state = makeState({ current_step: "commit" });
    const r = checkToolCall("Bash", { command: "git commit -m 'feat: done'" }, "readwrite", state);
    assert.equal(r.blocked, false);
  });

  test("git commit allowed in execute step", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Bash", { command: "git commit -m 'wip'" }, "readwrite", state);
    assert.equal(r.blocked, false);
  });
});

// ─── VG-08: git push restrictions ────────────────────────────────────────────

describe("VG-08: git push restrictions", () => {
  test("git push blocked before verify step completed", () => {
    const state = makeState({ current_step: "commit", completed_steps: [] });
    const r = checkToolCall("Bash", { command: "git push origin main" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-08");
  });

  test("git push allowed after verify completed", () => {
    const state = makeState({ current_step: "commit", completed_steps: ["init", "execute", "verify"] });
    const r = checkToolCall("Bash", { command: "git push origin main" }, "readwrite", state);
    assert.equal(r.blocked, false);
  });

  test("git push --force always blocked", () => {
    const state = makeState({ current_step: "commit", completed_steps: ["verify"] });
    const r = checkToolCall("Bash", { command: "git push --force origin main" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-08");
  });
});

// ─── VG-DESTROY: destructive commands ────────────────────────────────────────

describe("VG-DESTROY: Destructive command blocking", () => {
  test("git reset --hard blocked", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Bash", { command: "git reset --hard HEAD~1" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-DESTROY");
  });

  test("rm -rf outside .vela blocked", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Bash", { command: "rm -rf ./node_modules" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-DESTROY");
  });

  test("rm -rf inside .vela allowed", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Bash", { command: "rm -rf ./.vela/cache" }, "readwrite", state);
    assert.equal(r.blocked, false);
  });
});

// ─── VG-13: Path traversal ────────────────────────────────────────────────────

describe("VG-13: Path traversal prevention", () => {
  test("/../ in path blocked", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/run/../../etc/passwd", content: "x" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-13");
  });
});

// ─── VG-15: .vela-tmp files ──────────────────────────────────────────────────

describe("VG-15: .vela-tmp accumulation guard", () => {
  test("write to .vela-tmp blocked", () => {
    const state = makeState({ current_step: "execute" });
    const r = checkToolCall("Write", { file_path: "/project/temp.vela-tmp", content: "x" }, "readwrite", state);
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-15");
  });
});

// ─── VG-14: Concurrent pipeline ──────────────────────────────────────────────

describe("VG-14: Concurrent pipeline detection", () => {
  test("/vela start blocked when pipeline already active", () => {
    const state = makeState({ status: "active", current_step: "execute" });
    const r = checkToolCall("Bash", { command: "/vela start 'new task'" }, "readwrite", state, "/project");
    assert.equal(r.blocked, true);
    assert.equal(r.code, "VG-14");
  });
});
