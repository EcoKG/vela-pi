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
import type { PipelineMode } from "./pipeline.js";
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
/**
 * Run an isolated Pi SDK agent session for a pipeline role.
 *
 * Creates a fresh in-memory session, sends the role-specific system prompt
 * + task context, collects the response, and writes the output artifact.
 */
export declare function runVelaAgent(opts: DispatchOptions): Promise<DispatchResult>;
export declare function getAvailableRoles(): string[];
export declare function getRoleConfig(role: string): RoleConfig | null;
export {};
//# sourceMappingURL=dispatch.d.ts.map