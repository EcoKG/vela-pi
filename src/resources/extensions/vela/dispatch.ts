/**
 * Vela Agent Dispatcher — Phase 3
 *
 * Pi SDK-based replacement for scripts/shared/sdk-runner.js + sdk-{role}.js.
 *
 * Each /vela dispatch invocation creates an isolated, ephemeral AgentSession
 * (SessionManager.inMemory) with role-appropriate tools and system prompts.
 * Output is written to the pipeline artifact directory.
 *
 * Architecture:
 *   extension handler (/vela dispatch)
 *     → runVelaAgent(opts)
 *       → createAgentSession({ sessionManager: inMemory, tools })
 *       → session.prompt(task)
 *       → collect output
 *       → writeArtifact(artifactDir, filename, content)
 *       → return { ok, text, artifact }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  createAgentSession,
  readOnlyTools,
  codingTools,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";
import type { PipelineMode } from "./pipeline.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DispatchOptions {
  /** Pipeline role to run (researcher|planner|plan-checker|executor|reviewer|diff-summary|learning|finalize) */
  role: string;
  /** Project working directory */
  cwd: string;
  /** Artifact output directory for this pipeline run */
  artifactDir: string;
  /** The original user request */
  request: string;
  /** Task type (code|code-bug|code-refactor|docs|analysis) */
  taskType?: string;
  /** Pipeline mode determines available tools */
  pipelineMode?: PipelineMode;
  /** Optional additional context injected into the prompt */
  extraContext?: string;
  /** Timeout in ms (default: 300_000 = 5 min) */
  timeoutMs?: number;
}

export interface DispatchResult {
  ok: boolean;
  role: string;
  artifact?: string;
  text?: string;
  error?: string;
  durationMs?: number;
}

// ─── Role Configuration ───────────────────────────────────────────────────────

interface RoleConfig {
  systemPrompt: string;
  outputFile: string;
  /** Pi SDK tool set key */
  toolSet: "readOnly" | "coding" | "write";
  /** Human-readable description */
  description: string;
  /** Per-role timeout override in ms */
  timeoutMs?: number;
}

const ROLE_CONFIGS: Record<string, RoleConfig> = {
  researcher: {
    outputFile: "research.md",
    toolSet: "readOnly",
    description: "Research & Architecture Analysis",
    timeoutMs: 180_000,
    systemPrompt: `# Vela Researcher

You are a focused code researcher. Analyse the codebase for the given task request.

## Your mission
Produce a structured research.md with:
1. **Task summary** — what needs to change and why
2. **Affected files** — list files/modules that are relevant
3. **Architecture notes** — key patterns, dependencies, risks
4. **Security considerations** — potential vulnerabilities introduced
5. **Implementation hints** — recommended approach (not a full plan)

## Constraints
- Read-only access: you may ONLY use Read, Glob, Grep tools
- Be concise. Target 300-600 tokens of substance
- Do NOT start implementing — research only
- Write your final analysis as markdown to research.md in the artifact directory

## Output
Write your research to: {ARTIFACT_DIR}/research.md
Start with: # Research: {REQUEST}
`,
  },

  planner: {
    outputFile: "plan.md",
    toolSet: "coding",
    description: "Implementation Planning",
    systemPrompt: `# Vela Planner

You are a senior software architect. Create a detailed implementation plan.

## Your mission
Produce plan.md with these REQUIRED sections (each ≥ 200 bytes of substance):

### ## Architecture
Describe the high-level design: modules affected, patterns used, component interactions.

### ## Class Specification
List each class/function/interface to create or modify with signatures and responsibilities.

### ## Test Strategy
Describe the testing approach: unit tests, integration tests, edge cases.

## Additional sections
- Implementation Steps (ordered list)
- Risk Assessment
- Rollback Plan

## Constraints
- Base your plan on research.md if present in the artifact directory
- Be specific: file paths, function names, data structures
- Write plan.md to: {ARTIFACT_DIR}/plan.md

## Output
Start with: # Implementation Plan: {REQUEST}
`,
  },

  "plan-checker": {
    outputFile: "plan-check.md",
    toolSet: "readOnly",
    description: "Plan Verification",
    timeoutMs: 60_000,
    systemPrompt: `# Vela Plan Checker

You are a critical code reviewer. Verify the implementation plan.

## Your mission
Read plan.md from the artifact directory and verify:
1. All required sections exist and have substance (Architecture, Class Specification, Test Strategy)
2. The plan is technically sound and complete
3. There are no obvious gaps or contradictions
4. File paths and module names are plausible given the codebase

## Output
Write plan-check.md to: {ARTIFACT_DIR}/plan-check.md

Start with: # Plan Check: {STATUS}

Where STATUS is PASS or FAIL (uppercase). If FAIL, list specific issues.

Be concise. This is a verification step, not a redesign step.
`,
  },

  executor: {
    outputFile: "task-summary.md",
    toolSet: "coding",
    description: "Implementation",
    timeoutMs: 600_000,
    systemPrompt: `# Vela Executor

You are a precise software engineer. Implement the plan exactly as specified.

## Your mission
1. Read plan.md from the artifact directory
2. Implement the changes described in the plan
3. Write task-summary.md summarising what was done

## Constraints
- Follow the plan exactly — no scope creep
- Write tests before implementation (TDD where applicable)
- Keep changes focused — do not refactor unrelated code
- After implementation, write: {ARTIFACT_DIR}/task-summary.md

## Output (task-summary.md)
- Files modified (list)
- Key changes made
- Test results (pass/fail)
- Any deviations from plan and why

Start with: # Task Summary: {REQUEST}
`,
  },

  reviewer: {
    outputFile: "review-execute.md",
    toolSet: "readOnly",
    description: "Code Review",
    timeoutMs: 180_000,
    systemPrompt: `# Vela Reviewer

You are a rigorous code reviewer. Review the implementation.

## Your mission
1. Read plan.md and task-summary.md from the artifact directory
2. Read the modified source files
3. Write a review assessing correctness, quality, and security

## Scoring (0-100)
- Correctness: does it match the plan?
- Code quality: style, clarity, maintainability
- Test coverage: are tests sufficient?
- Security: no new vulnerabilities?

## Output
Write review-execute.md to: {ARTIFACT_DIR}/review-execute.md

Include:
- VERDICT: APPROVE or REJECT
- Score breakdown
- Issues list (if any)
- Approval JSON: write {ARTIFACT_DIR}/approval-execute.json

approval-execute.json format:
{"decision": "approve"|"reject", "score": 0-100, "issues": [...]}

Start with: # Code Review: {VERDICT}
`,
  },

  "diff-summary": {
    outputFile: "diff-summary.md",
    toolSet: "readOnly",
    description: "Diff Summary",
    systemPrompt: `# Vela Diff Summariser

You are a technical writer. Summarise the changes made.

## Your mission
1. Read diff.patch from the artifact directory (if present)
2. Read task-summary.md
3. Write a human-readable summary of what changed and why

## Output
Write diff-summary.md to: {ARTIFACT_DIR}/diff-summary.md
Write approval-diff-summary.json to: {ARTIFACT_DIR}/approval-diff-summary.json

diff-summary.md should include:
- Summary paragraph (2-3 sentences)
- Changed files table
- Key decisions made

approval-diff-summary.json: {"decision": "approve"}

Start with: # Change Summary: {REQUEST}
`,
  },

  learning: {
    outputFile: "learning.md",
    toolSet: "readOnly",
    description: "Learning Extraction",
    systemPrompt: `# Vela Learning Extractor

Extract learnings and patterns from this pipeline run.

## Your mission
Read research.md, plan.md, review-execute.md, and diff-summary.md from the artifact directory.
Write learning.md capturing:
1. What worked well
2. What was difficult or unexpected
3. Patterns to reuse in future tasks
4. Anti-patterns to avoid
5. Suggested improvements to the pipeline or codebase

## Output
Write learning.md to: {ARTIFACT_DIR}/learning.md

Keep it concise: 200-400 tokens. Focus on actionable insights.

Start with: # Learnings: {REQUEST}
`,
  },

  "sprint-planner": {
    outputFile: "sprint-plan.json",
    toolSet: "readOnly",
    description: "Sprint Decomposition Planning",
    timeoutMs: 90_000,
    systemPrompt: `# Vela Sprint Planner

You are a sprint architect. Decompose a high-level request into focused, parallelisable work slices.

## Your mission
Analyse the request and produce a structured JSON sprint plan.

## Output format
Respond with a JSON code block containing:

\`\`\`json
{
  "title": "<short sprint title>",
  "description": "<2-3 sentence description>",
  "slices": [
    {
      "id": "slice-1",
      "title": "<short slice title>",
      "description": "<what this slice implements, 1-2 sentences>",
      "depends_on": []
    },
    {
      "id": "slice-2",
      "title": "<short slice title>",
      "description": "<what this slice implements>",
      "depends_on": ["slice-1"]
    }
  ]
}
\`\`\`

## Constraints
- 3-8 slices for most requests; never more than 12
- Each slice should be independently testable
- Use depends_on to express ordering dependencies (DAG, no cycles)
- Be specific about what each slice implements
- Slice IDs must be unique strings (e.g. "slice-1", "slice-2")

Request: {REQUEST}
`,
  },

  finalizer: {
    outputFile: "report.md",
    toolSet: "coding",
    description: "Pipeline Finalisation",
    timeoutMs: 120_000,
    systemPrompt: `# Vela Finaliser

Wrap up the pipeline and produce the final report.

## Your mission
Read all artifact files and produce a final report.md summarising the entire pipeline run.

## Output
Write report.md to: {ARTIFACT_DIR}/report.md

Include:
- Executive summary (3-5 sentences)
- What was built/changed
- Key metrics (files changed, tests, score)
- Next steps / PR description

Start with: # Pipeline Report: {REQUEST}
`,
  },

  "pm": {
    outputFile: "pm-decision.md",
    toolSet: "readOnly",
    description: "PM Orchestration Decision",
    systemPrompt: `# Vela PM

You are a pipeline orchestrator. Read all available artifacts and decide next action.

## Your mission
1. Read all artifacts in {ARTIFACT_DIR}/
2. Assess the current pipeline state
3. Decide the next action

## Decision matrix
- All artifacts present and approved → ACTION: proceed
- Review rejected (review-*.md contains REJECT) → ACTION: retry
- Plan incomplete (plan.md < 500 bytes or missing sections) → ACTION: replanning
- Critical blocker found → ACTION: escalate
- Missing artifacts → ACTION: dispatch <role>

## Output
Write pm-decision.md to: {ARTIFACT_DIR}/pm-decision.md

Format:
\`\`\`
ACTION: proceed|retry|replanning|escalate|dispatch <role>
REASON: <1-2 sentences>
DETAILS: <optional specifics>
\`\`\`

Start with: # PM Decision: {REQUEST}
`,
  },
};

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

/**
 * Run an isolated Pi SDK agent session for a pipeline role.
 *
 * Creates a fresh in-memory session, sends the role-specific system prompt
 * + task context, collects the response, and writes the output artifact.
 */
export async function runVelaAgent(opts: DispatchOptions): Promise<DispatchResult> {
  const start = Date.now();
  const { role, cwd, artifactDir, request, taskType = "code", timeoutMs = 300_000 } = opts;

  // researcher role: run parallel 3-perspective analysis
  if (role === "researcher") {
    return runParallelResearch(opts);
  }

  const roleConfig = ROLE_CONFIGS[role];
  if (!roleConfig) {
    return {
      ok: false,
      role,
      error: `Unknown role: ${role}. Available: ${Object.keys(ROLE_CONFIGS).join(", ")}`,
    };
  }

  const effectiveTimeout = roleConfig.timeoutMs ?? timeoutMs;

  // Build system prompt with template substitution
  const systemPrompt = roleConfig.systemPrompt
    .replace(/\{ARTIFACT_DIR\}/g, artifactDir)
    .replace(/\{REQUEST\}/g, request)
    .replace(/\{TASK_TYPE\}/g, taskType);

  // Select tools based on role's tool set
  const tools =
    roleConfig.toolSet === "readOnly"
      ? readOnlyTools
      : codingTools;

  // Build session options
  const sessionOpts: CreateAgentSessionOptions = {
    cwd,
    tools,
    sessionManager: SessionManager.inMemory(cwd),
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

  try {
    const { session: s } = await createAgentSession(sessionOpts);
    session = s;

    // Build the user task prompt
    const contextFiles = buildContextPrompt(artifactDir, role);
    const taskPrompt = buildTaskPrompt(role, request, taskType, contextFiles);

    // Send system prompt as initial context, then the task
    // Pi SDK: set system prompt override via prompt with prepended context
    const fullPrompt = `${systemPrompt}\n\n---\n\n${taskPrompt}`;

    // Set up timeout
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      session?.abort().catch(() => {});
    }, effectiveTimeout);

    try {
      await session.prompt(fullPrompt);
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      return {
        ok: false,
        role,
        error: `Agent timed out after ${effectiveTimeout / 1000}s`,
        durationMs: Date.now() - start,
      };
    }

    // Collect the assistant's final response
    const text = session.getLastAssistantText() ?? "";

    // Write artifact if the agent didn't write it directly
    const artifactPath = join(artifactDir, roleConfig.outputFile);
    if (!existsSync(artifactPath) && text.trim()) {
      writeArtifact(artifactPath, text);
    }

    // Accumulate learnings if this is the learning role
    if (role === "learning" && text.trim()) {
      accumulateLearning(cwd, request, artifactDir, text);
    }

    return {
      ok: true,
      role,
      text,
      artifact: roleConfig.outputFile,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      ok: false,
      role,
      error: (e as Error).message ?? String(e),
      durationMs: Date.now() - start,
    };
  } finally {
    session?.dispose();
  }
}

// ─── Parallel Research ────────────────────────────────────────────────────────

async function runParallelResearch(opts: DispatchOptions): Promise<DispatchResult> {
  const start = Date.now();
  const { cwd, artifactDir, request, taskType = "code", timeoutMs = 300_000 } = opts;

  const perspectives = [
    { key: "architecture", focus: "Architecture & Design patterns, module dependencies, component interactions" },
    { key: "security",     focus: "Security vulnerabilities, injection risks, auth issues, sensitive data exposure" },
    { key: "quality",      focus: "Code quality, test coverage gaps, performance issues, maintainability" },
  ];

  const perspectiveResults = await Promise.allSettled(
    perspectives.map(async ({ key, focus }) => {
      const sessionOpts = {
        cwd,
        tools: readOnlyTools,
        sessionManager: SessionManager.inMemory(cwd),
      };
      const { session: s } = await createAgentSession(sessionOpts);
      try {
        const prompt = `You are a ${key} analyst. Focus on: ${focus}\n\nRequest: ${request}\nTask type: ${taskType}\n\nAnalyse the codebase and write your findings as markdown. Be concise (200-400 tokens).`;
        let timedOut = false;
        const th = setTimeout(() => { timedOut = true; s.abort().catch(() => {}); }, timeoutMs / 3);
        try { await s.prompt(prompt); } finally { clearTimeout(th); }
        if (timedOut) return { key, text: `(timed out)` };
        return { key, text: s.getLastAssistantText() ?? "" };
      } finally {
        s.dispose();
      }
    })
  );

  // Merge results into research.md
  const sections: string[] = [`# Research: ${request}\n`];
  for (const result of perspectiveResults) {
    if (result.status === "fulfilled") {
      const { key, text } = result.value;
      sections.push(`## ${key.charAt(0).toUpperCase() + key.slice(1)} Analysis\n\n${text}`);
    } else {
      sections.push(`## (Analysis failed: ${result.reason})`);
    }
  }

  const merged = sections.join("\n\n---\n\n");
  const artifactPath = join(artifactDir, "research.md");
  if (!existsSync(artifactPath)) {
    writeArtifact(artifactPath, merged);
  }

  return {
    ok: true,
    role: "researcher",
    text: merged,
    artifact: "research.md",
    durationMs: Date.now() - start,
  };
}

// ─── Learning Accumulation ────────────────────────────────────────────────────

function accumulateLearning(
  cwd: string,
  request: string,
  _artifactDir: string,
  learningText: string
): void {
  try {
    const accPath = join(cwd, ".vela", "learnings.json");
    let existing: Array<{ date: string; request: string; summary: string }> = [];
    if (existsSync(accPath)) {
      existing = JSON.parse(readFileSync(accPath, "utf8"));
    }
    existing.push({
      date: new Date().toISOString().substring(0, 10),
      request: request.substring(0, 100),
      summary: learningText.substring(0, 500),
    });
    // Keep last 100 entries
    if (existing.length > 100) existing = existing.slice(-100);
    writeArtifact(accPath, JSON.stringify(existing, null, 2));
  } catch {
    // non-fatal
  }
}

// ─── Context Builder ──────────────────────────────────────────────────────────

/** Read existing artifact files relevant to this role's input. */
function buildContextPrompt(artifactDir: string, role: string): string {
  const inputFiles: Record<string, string[]> = {
    researcher: [],
    planner: ["research.md"],
    "plan-checker": ["plan.md"],
    executor: ["plan.md", "plan-check.md"],
    reviewer: ["plan.md", "task-summary.md"],
    "diff-summary": ["task-summary.md", "diff.patch"],
    learning: ["research.md", "plan.md", "review-execute.md", "diff-summary.md"],
    finalizer: ["research.md", "plan.md", "task-summary.md", "review-execute.md", "diff-summary.md", "learning.md"],
  };

  const files = inputFiles[role] ?? [];
  const parts: string[] = [];

  for (const filename of files) {
    const filePath = join(artifactDir, filename);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8").trim();
      if (content) {
        parts.push(`## ${filename}\n\n${content}`);
      }
    } catch {
      // skip unreadable files
    }
  }

  return parts.join("\n\n---\n\n");
}

function buildTaskPrompt(
  role: string,
  request: string,
  taskType: string,
  contextFiles: string
): string {
  const lines = [
    `## Task`,
    `Request: ${request}`,
    `Type: ${taskType}`,
    `Role: ${role}`,
  ];

  if (contextFiles) {
    lines.push("", "## Context from previous steps", "", contextFiles);
  }

  lines.push("", "## Instructions", "Proceed with your assigned role as described in the system prompt above.");

  return lines.join("\n");
}

// ─── Artifact Writing ─────────────────────────────────────────────────────────

function writeArtifact(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

// ─── Available Roles ──────────────────────────────────────────────────────────

export function getAvailableRoles(): string[] {
  return Object.keys(ROLE_CONFIGS);
}

export function getRoleConfig(role: string): RoleConfig | null {
  return ROLE_CONFIGS[role] ?? null;
}
