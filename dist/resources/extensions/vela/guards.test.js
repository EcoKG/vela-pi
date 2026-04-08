/**
 * guards.test.ts — unit tests for checkToolCall gate enforcement
 *
 * Run with:
 *   npm test
 *   node --experimental-strip-types --test src/resources/extensions/vela/guards.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkToolCall, getEffectiveWriteTools } from "./guards.js";
// ─── Shared mock pipeline definition ─────────────────────────────────────────
const MOCK_DEF = {
    version: "1.2",
    pipelines: {},
    modes: {
        read: {
            allowed_tools: ["Read", "Glob", "Grep", "Agent"],
            blocked_tools: ["Edit", "Write", "NotebookEdit"],
            bash_policy: "read_only",
            treenode_cache: true,
        },
        write: {
            allowed_tools: ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"],
            blocked_tools: [],
            bash_policy: "blocked",
            treenode_cache: false,
        },
        readwrite: {
            allowed_tools: ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Agent"],
            blocked_tools: [],
            bash_policy: "restricted",
            treenode_cache: true,
        },
        "rw-artifact": {
            allowed_tools: ["Read", "Glob", "Grep", "Write", "Agent"],
            blocked_tools: ["Edit", "NotebookEdit"],
            bash_policy: "read_only",
            treenode_cache: true,
            artifact_write_only: true,
        },
    },
};
// ─── getEffectiveWriteTools ───────────────────────────────────────────────────
describe("getEffectiveWriteTools", () => {
    it("derives write tools from modes.read.blocked_tools when def is provided", () => {
        const wt = getEffectiveWriteTools(MOCK_DEF);
        assert.ok(wt.has("Edit"));
        assert.ok(wt.has("Write"));
        assert.ok(wt.has("NotebookEdit"));
        assert.equal(wt.size, 3);
    });
    it("returns hardcoded fallback when def is absent", () => {
        const wt = getEffectiveWriteTools(undefined);
        assert.ok(wt.has("Edit"));
        assert.ok(wt.has("Write"));
        assert.ok(wt.has("NotebookEdit"));
    });
    it("reflects custom blocked_tools when def is extended", () => {
        const custom = {
            ...MOCK_DEF,
            modes: {
                ...MOCK_DEF.modes,
                read: {
                    ...MOCK_DEF.modes["read"],
                    blocked_tools: ["Edit", "Write", "NotebookEdit", "CustomTool"],
                },
            },
        };
        const wt = getEffectiveWriteTools(custom);
        assert.ok(wt.has("CustomTool"));
        assert.equal(wt.size, 4);
    });
});
// ─── VK-03: blocked_tools enforcement ────────────────────────────────────────
describe("VK-03: data-driven blocked_tools", () => {
    it("blocks Write in read mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/src/foo.ts" }, "read", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("blocks Edit in read mode", () => {
        const r = checkToolCall("Edit", { file_path: "/project/src/foo.ts" }, "read", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("blocks NotebookEdit in read mode", () => {
        const r = checkToolCall("NotebookEdit", { file_path: "/project/foo.ipynb" }, "read", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("blocks Edit in rw-artifact mode (via blocked_tools)", () => {
        const r = checkToolCall("Edit", { file_path: "/project/src/foo.ts" }, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("blocks NotebookEdit in rw-artifact mode (via blocked_tools)", () => {
        const r = checkToolCall("NotebookEdit", { file_path: "/foo.ipynb" }, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("allows Write in write mode (blocked_tools is empty)", () => {
        const r = checkToolCall("Write", { file_path: "/project/src/foo.ts" }, "write", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("allows Edit in write mode", () => {
        const r = checkToolCall("Edit", { file_path: "/project/src/foo.ts" }, "write", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("allows Write in readwrite mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/src/foo.ts" }, "readwrite", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
});
// ─── VK-04: artifact_write_only enforcement ──────────────────────────────────
describe("VK-04: artifact_write_only", () => {
    it("blocks Write to a source file in rw-artifact mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/src/foo.ts" }, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-04");
    });
    it("allows Write inside .vela/artifacts/ in rw-artifact mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/20240101T000000-slug/research.md" }, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("blocks Write with no file path in rw-artifact mode (empty path is not in artifact dir)", () => {
        // Empty path passes the "!filePath" guard → allowed (consistent with original)
        const r = checkToolCall("Write", {}, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("does NOT apply artifact_write_only in write mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/src/foo.ts" }, "write", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
});
// ─── Bash policy (data-driven) ────────────────────────────────────────────────
describe("Bash: data-driven bash_policy", () => {
    it("blocks all Bash in write mode (bash_policy: blocked)", () => {
        const r = checkToolCall("Bash", { command: "ls" }, "write", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-01");
    });
    it("allows safe Bash in read mode (bash_policy: read_only)", () => {
        const r = checkToolCall("Bash", { command: "ls" }, "read", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("blocks write Bash in read mode (bash_policy: read_only)", () => {
        const r = checkToolCall("Bash", { command: "rm -rf /tmp/foo" }, "read", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-01");
    });
    it("allows any Bash in readwrite mode (bash_policy: restricted)", () => {
        const r = checkToolCall("Bash", { command: "npm install lodash" }, "readwrite", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("allows safe Bash in rw-artifact mode (bash_policy: read_only)", () => {
        const r = checkToolCall("Bash", { command: "git status" }, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, false);
    });
    it("blocks write Bash in rw-artifact mode (bash_policy: read_only)", () => {
        const r = checkToolCall("Bash", { command: "git commit -m msg" }, "rw-artifact", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-01");
    });
});
// ─── Backward compatibility (no pipelineDef) ─────────────────────────────────
describe("Backward compat: no pipelineDef → same behaviour as hardcoded", () => {
    it("blocks Write in read mode", () => {
        const r = checkToolCall("Write", { file_path: "/foo.ts" }, "read");
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("blocks Edit in read mode", () => {
        const r = checkToolCall("Edit", { file_path: "/foo.ts" }, "read");
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("blocks Bash in write mode", () => {
        const r = checkToolCall("Bash", { command: "ls" }, "write");
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-01");
    });
    it("allows Write in write mode", () => {
        const r = checkToolCall("Write", { file_path: "/foo.ts" }, "write");
        assert.equal(r.blocked, false);
    });
    it("blocks Write to non-artifact path in rw-artifact mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/src/foo.ts" }, "rw-artifact");
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-04");
    });
    it("allows Write inside .vela/artifacts/ in rw-artifact mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/20240101T000000-slug/research.md" }, "rw-artifact");
        assert.equal(r.blocked, false);
    });
    it("allows safe Bash in read mode", () => {
        const r = checkToolCall("Bash", { command: "ls" }, "read");
        assert.equal(r.blocked, false);
    });
});
// ─── Extensibility: custom pipeline.json ─────────────────────────────────────
describe("Extensibility: custom blocked_tools are enforced", () => {
    it("blocks a custom tool added to modes.read.blocked_tools", () => {
        const customDef = {
            ...MOCK_DEF,
            modes: {
                ...MOCK_DEF.modes,
                read: {
                    ...MOCK_DEF.modes["read"],
                    blocked_tools: ["Edit", "Write", "NotebookEdit", "CustomTool"],
                },
            },
        };
        const r = checkToolCall("CustomTool", {}, "read", null, undefined, customDef);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
    it("allows a tool removed from modes.read.blocked_tools (custom permissive def)", () => {
        // If someone removes Write from read.blocked_tools, it should no longer be subject to VK-03
        // (though VK-05/VK-06 may still apply for path/content reasons)
        const permissiveDef = {
            ...MOCK_DEF,
            modes: {
                ...MOCK_DEF.modes,
                read: {
                    ...MOCK_DEF.modes["read"],
                    blocked_tools: ["Edit", "NotebookEdit"], // Write removed
                },
            },
        };
        const r = checkToolCall("Write", { file_path: "/foo.ts" }, "read", null, undefined, permissiveDef);
        // Write is no longer in blocked_tools or effectiveWriteTools → allowed
        assert.equal(r.blocked, false);
    });
    it("blocks a tool added to rw-artifact.blocked_tools", () => {
        const customDef = {
            ...MOCK_DEF,
            modes: {
                ...MOCK_DEF.modes,
                "rw-artifact": {
                    ...MOCK_DEF.modes["rw-artifact"],
                    blocked_tools: ["Edit", "NotebookEdit", "Write"], // Write also blocked
                },
            },
        };
        const r = checkToolCall("Write", { file_path: "/project/.vela/artifacts/20240101T000000-slug/research.md" }, "rw-artifact", null, undefined, customDef);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-03");
    });
});
// ─── Security checks still apply regardless of def ───────────────────────────
describe("VK-05 / VK-06 security checks still active", () => {
    it("VK-05 blocks write to .env in write mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/.env" }, "write", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-05");
    });
    it("VK-06 blocks content with AWS key in write mode", () => {
        const r = checkToolCall("Write", { file_path: "/project/config.ts", content: "const key = 'AKIAIOSFODNN7EXAMPLE1234'" }, "write", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-06");
    });
    it("VK-06 blocks Bash command containing Anthropic key", () => {
        const r = checkToolCall("Bash", { command: "export KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "readwrite", null, undefined, MOCK_DEF);
        assert.equal(r.blocked, true);
        assert.equal(r.code, "VK-06");
    });
});
//# sourceMappingURL=guards.test.js.map