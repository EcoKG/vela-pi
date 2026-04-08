/**
 * Vela Standalone CLI
 *
 * Direct @mariozechner/pi-coding-agent entry point — no GSD dependencies.
 *
 * Flow:
 *   loader.ts sets PI_PACKAGE_DIR, PI_APP_NAME, PI_CODING_AGENT_DIR, VELA_EXT_PATH
 *     → imports this file
 *     → wires Vela extension via DefaultResourceLoader.additionalExtensionPaths
 *     → runs InteractiveMode (TUI) or runPrintMode / runRpcMode
 *
 * Supported flags:
 *   --version / -v           print version
 *   --help / -h              print help
 *   --print / -p             single-shot print mode
 *   --mode text|json|rpc     output mode (print mode variant)
 *   --model <id>             override model
 *   --continue / -c          continue most recent session
 *   --no-session             ephemeral session (no disk persistence)
 *   --append-system-prompt <text|file>
 *   --list-models [filter]   list available models and exit
 *   --verbose                verbose startup output
 *   <message>                initial message (interactive mode)
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SettingsManager, SessionManager, createAgentSession, InteractiveMode, runPrintMode, runRpcMode, } from "@mariozechner/pi-coding-agent";
// ─── Paths ────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const req = createRequire(import.meta.url);
const pkg = req(join(__dirname, "..", "package.json"));
const APP_NAME = process.env.PI_APP_NAME ?? pkg.piConfig?.name ?? "vela";
const APP_VERSION = pkg.version;
// PI_CODING_AGENT_DIR set by loader.ts; fallback to ~/.vela/agent
const agentDir = process.env.PI_CODING_AGENT_DIR ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? "", `.${APP_NAME}`, "agent");
// Vela extension path injected by loader.ts
const velaExtPath = process.env.VELA_EXT_PATH ?? "";
function parseCliArgs(argv) {
    const flags = { messages: [], extensions: [] };
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--mode" && i + 1 < args.length) {
            const m = args[++i];
            if (m === "text" || m === "json" || m === "rpc")
                flags.mode = m;
        }
        else if (arg === "--print" || arg === "-p") {
            flags.print = true;
        }
        else if (arg === "--continue" || arg === "-c") {
            flags.continue = true;
        }
        else if (arg === "--no-session") {
            flags.noSession = true;
        }
        else if (arg === "--model" && i + 1 < args.length) {
            flags.model = args[++i];
        }
        else if (arg === "--extension" && i + 1 < args.length) {
            flags.extensions.push(args[++i]);
        }
        else if (arg === "--append-system-prompt" && i + 1 < args.length) {
            flags.appendSystemPrompt = args[++i];
        }
        else if (arg === "--list-models") {
            flags.listModels =
                i + 1 < args.length && !args[i + 1].startsWith("-")
                    ? args[++i]
                    : true;
        }
        else if (arg === "--version" || arg === "-v") {
            process.stdout.write(APP_VERSION + "\n");
            process.exit(0);
        }
        else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
        else if (arg === "--verbose") {
            flags.verbose = true;
        }
        else if (!arg.startsWith("--") && !arg.startsWith("-")) {
            flags.messages.push(arg);
        }
    }
    return flags;
}
function printHelp() {
    process.stdout.write(`${APP_NAME} v${APP_VERSION} — Vela deterministic pipeline engine\n\n` +
        `Usage: ${APP_NAME} [options] [message]\n\n` +
        `Options:\n` +
        `  --print, -p          Single-shot: send message, print response, exit\n` +
        `  --mode text|json|rpc Output mode (use with --print)\n` +
        `  --model <id>         Override model (e.g. anthropic/claude-opus-4-5)\n` +
        `  --continue, -c       Continue most recent session\n` +
        `  --no-session         Ephemeral session (no disk persistence)\n` +
        `  --list-models        List available models and exit\n` +
        `  --verbose            Verbose startup output\n` +
        `  --version, -v        Print version\n` +
        `  --help, -h           Print this help\n\n` +
        `Vela commands (inside session):\n` +
        `  /vela start "<request>"   Start a new pipeline\n` +
        `  /vela status              Show pipeline state\n` +
        `  /vela transition          Advance to next step\n` +
        `  /vela dispatch <role>     Run agent for current step\n` +
        `  /vela sprint run|status   Sprint orchestration\n` +
        `  /vela help                Show all Vela commands\n`);
}
// ─── Main ─────────────────────────────────────────────────────────────────────
const cliFlags = parseCliArgs(process.argv);
const isPrintMode = cliFlags.print === true || cliFlags.mode !== undefined;
// TTY check
if (!process.stdin.isTTY && !isPrintMode && cliFlags.listModels === undefined) {
    process.stderr.write(`[${APP_NAME}] Error: Interactive mode requires a terminal (TTY).\n` +
        `[${APP_NAME}] Non-interactive alternatives:\n` +
        `[${APP_NAME}]   ${APP_NAME} --print "your message"\n` +
        `[${APP_NAME}]   ${APP_NAME} --mode rpc\n`);
    process.exit(1);
}
// V8 compile cache (Node 22+)
if (parseInt(process.versions.node) >= 22) {
    process.env.NODE_COMPILE_CACHE ??= join(agentDir, ".compile-cache");
}
// ─── Core Setup ──────────────────────────────────────────────────────────────
const authFilePath = join(agentDir, "auth.json");
const authStorage = AuthStorage.create(authFilePath);
const modelsJsonPath = join(agentDir, "models.json");
const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath);
const settingsManager = SettingsManager.create(agentDir);
// Quiet Vela-branded startup
if (!settingsManager.getQuietStartup())
    settingsManager.setQuietStartup(true);
if (!settingsManager.getCollapseChangelog())
    settingsManager.setCollapseChangelog(true);
// ─── API key validation ───────────────────────────────────────────────────────
// Run after settingsManager so quiet mode is set, but always show auth errors.
if (cliFlags.listModels === undefined && !isPrintMode) {
    // Check for any API key in env or auth.json
    const hasEnvKey = process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GEMINI_API_KEY;
    if (!hasEnvKey) {
        // Try to detect if auth.json has stored keys
        const authExists = existsSync(authFilePath);
        if (!authExists) {
            process.stderr.write(`\n[vela] No API key found.\n` +
                `  Set an environment variable, e.g.:\n` +
                `    export ANTHROPIC_API_KEY=sk-ant-...\n` +
                `  Or run: vela --setup-auth (coming soon)\n\n`);
            // Non-fatal: continue and let pi-coding-agent handle the error
        }
    }
}
// ─── --list-models ────────────────────────────────────────────────────────────
if (cliFlags.listModels !== undefined) {
    const models = modelRegistry.getAvailable();
    if (models.length === 0) {
        console.log("No models available. Set ANTHROPIC_API_KEY or configure auth.json.");
        process.exit(0);
    }
    const searchPattern = typeof cliFlags.listModels === "string" ? cliFlags.listModels : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filtered = models;
    if (searchPattern) {
        const q = searchPattern.toLowerCase();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filtered = models.filter((m) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filtered.sort((a, b) => a.provider.localeCompare(b.provider) ||
        a.id.localeCompare(b.id));
    const hdrs = ["provider", "model", "name"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = filtered.map((m) => [m.provider, m.id, m.name]);
    const widths = hdrs.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const pad = (s, w) => s.padEnd(w);
    console.log(hdrs.map((h, i) => pad(h, widths[i])).join("  "));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
        console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
    }
    process.exit(0);
}
// ─── Resource Loader — wires Vela extension ───────────────────────────────────
// Resolve --append-system-prompt (file path or literal text)
let appendSystemPrompt;
if (cliFlags.appendSystemPrompt) {
    try {
        appendSystemPrompt = existsSync(cliFlags.appendSystemPrompt)
            ? readFileSync(cliFlags.appendSystemPrompt, "utf-8")
            : cliFlags.appendSystemPrompt;
    }
    catch {
        appendSystemPrompt = cliFlags.appendSystemPrompt;
    }
}
// Collect extension paths: Vela extension + any --extension flags
const additionalExtensionPaths = [];
if (velaExtPath && existsSync(velaExtPath)) {
    additionalExtensionPaths.push(velaExtPath);
}
for (const extPath of cliFlags.extensions) {
    if (existsSync(extPath))
        additionalExtensionPaths.push(extPath);
}
const resourceLoader = new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: additionalExtensionPaths.length > 0
        ? additionalExtensionPaths
        : undefined,
    appendSystemPrompt,
});
await resourceLoader.reload();
// ─── Session Manager ──────────────────────────────────────────────────────────
let sessionManager;
if (cliFlags.noSession) {
    sessionManager = SessionManager.inMemory();
}
else if (cliFlags._selectedSessionPath) {
    sessionManager = SessionManager.open(cliFlags._selectedSessionPath);
}
else if (cliFlags.continue) {
    sessionManager = SessionManager.continueRecent(process.cwd());
}
else {
    sessionManager = SessionManager.create(process.cwd());
}
// ─── Agent Session ────────────────────────────────────────────────────────────
const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
});
// Log non-fatal extension errors
for (const err of extensionsResult.errors) {
    process.stderr.write(`[${APP_NAME}] Extension error: ${err.error}\n`);
}
// Apply --model override
if (cliFlags.model) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const available = modelRegistry.getAvailable();
    const match = available.find((m) => m.id === cliFlags.model) ??
        available.find((m) => `${m.provider}/${m.id}` === cliFlags.model);
    if (match) {
        try {
            await session.setModel(match);
        }
        catch {
            // non-fatal
        }
    }
}
// ─── Print / RPC Mode ─────────────────────────────────────────────────────────
// @mariozechner/pi-coding-agent: InteractiveMode/runPrintMode/runRpcMode accept
// AgentSessionRuntime (internal type). Cast via unknown since AgentSession is
// the public interface but shares the same runtime shape at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionRuntime = session;
if (isPrintMode) {
    const mode = cliFlags.mode ?? "text";
    if (mode === "rpc") {
        await runRpcMode(sessionRuntime);
        session.dispose();
        process.exit(0);
    }
    const initialMessage = cliFlags.messages[0];
    await runPrintMode(sessionRuntime, {
        mode: mode === "json" ? "json" : "text",
        initialMessage,
        messages: cliFlags.messages.slice(1),
    });
    session.dispose();
    process.exit(0);
}
// ─── Interactive TUI Mode ─────────────────────────────────────────────────────
const initialMessage = cliFlags.messages.length > 0 ? cliFlags.messages.join(" ") : undefined;
const interactiveMode = new InteractiveMode(sessionRuntime, {
    modelFallbackMessage,
    initialMessage,
    verbose: cliFlags.verbose === true,
});
await interactiveMode.run();
session.dispose();
process.exit(0);
//# sourceMappingURL=cli.js.map