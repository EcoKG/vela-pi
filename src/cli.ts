/**
 * Vela Standalone CLI
 *
 * Direct @mariozechner/pi-coding-agent entry point — no GSD dependencies.
 *
 * Flow:
 *   loader.ts sets PI_PACKAGE_DIR, PI_APP_NAME, PI_CODING_AGENT_DIR, VELA_EXT_PATH
 *     → imports this file
 *     → wires Vela extension via createAgentSessionServices resourceLoaderOptions
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
import {
  AuthStorage,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  InteractiveMode,
  runPrintMode,
  runRpcMode,
} from "@mariozechner/pi-coding-agent";

// ─── VelaRuntime Interface ────────────────────────────────────────────────────

interface VelaRuntime {
  diagnostics: Array<{ type: string; message: string }>;
  dispose(): Promise<void>;
  services: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelRegistry: { getAvailable(): Array<{ provider: string; id: string; name: string } & Record<string, any>> };
  };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const req = createRequire(import.meta.url);
const pkg = req(join(__dirname, "..", "package.json")) as {
  version: string;
  piConfig?: { name?: string; configDir?: string };
};

const APP_NAME = process.env.PI_APP_NAME ?? pkg.piConfig?.name ?? "vela";
const APP_VERSION = pkg.version;

// PI_CODING_AGENT_DIR set by loader.ts; fallback to ~/.vela/agent
const agentDir =
  process.env.PI_CODING_AGENT_DIR ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? "", `.${APP_NAME}`, "agent");

// Vela extension path injected by loader.ts
const velaExtPath = process.env.VELA_EXT_PATH ?? "";

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

interface CliFlags {
  print?: boolean;
  mode?: "text" | "json" | "rpc";
  model?: string;
  continue?: boolean;
  noSession?: boolean;
  appendSystemPrompt?: string;
  listModels?: boolean | string;
  messages: string[];
  extensions: string[];
  verbose?: boolean;
  _selectedSessionPath?: string;
}

function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { messages: [], extensions: [] };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode" && i + 1 < args.length) {
      const m = args[++i];
      if (m === "text" || m === "json" || m === "rpc") flags.mode = m;
    } else if (arg === "--print" || arg === "-p") {
      flags.print = true;
    } else if (arg === "--continue" || arg === "-c") {
      flags.continue = true;
    } else if (arg === "--no-session") {
      flags.noSession = true;
    } else if (arg === "--model" && i + 1 < args.length) {
      flags.model = args[++i];
    } else if (arg === "--extension" && i + 1 < args.length) {
      flags.extensions.push(args[++i]);
    } else if (arg === "--append-system-prompt" && i + 1 < args.length) {
      flags.appendSystemPrompt = args[++i];
    } else if (arg === "--list-models") {
      flags.listModels =
        i + 1 < args.length && !args[i + 1].startsWith("-")
          ? args[++i]
          : true;
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(APP_VERSION + "\n");
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--verbose") {
      flags.verbose = true;
    } else if (!arg.startsWith("--") && !arg.startsWith("-")) {
      flags.messages.push(arg);
    }
  }

  return flags;
}

function printHelp(): void {
  const c = (s: string) => `\x1b[36m${s}\x1b[0m`;   // cyan
  const b = (s: string) => `\x1b[1m${s}\x1b[0m`;    // bold
  const bc = (s: string) => `\x1b[1m\x1b[36m${s}\x1b[0m`; // bold cyan

  process.stdout.write(
    `\n` +
    `  ${bc("╔════════════════════════════════════════════╗")}\n` +
    `  ${bc(`║  ⛵  VELA v${APP_VERSION} — pipeline engine`.padEnd(46))}${bc("║")}\n` +
    `  ${bc("╚════════════════════════════════════════════╝")}\n` +
    `\n` +
    `  ${b("Usage:")}  ${APP_NAME} [options] [message]\n` +
    `           ${APP_NAME} --print "your question"\n` +
    `\n` +
    `  ${c("── CLI Options ──────────────────────────────")}\n` +
    `    --print, -p           Single-shot print mode\n` +
    `    --mode text|json|rpc  Output format (with --print)\n` +
    `    --model <id>          Override model\n` +
    `    --continue, -c        Continue most recent session\n` +
    `    --no-session          Ephemeral (no disk persistence)\n` +
    `    --list-models [q]     List available models and exit\n` +
    `    --verbose             Verbose startup output\n` +
    `    --version, -v         Print version\n` +
    `    --help, -h            This help\n` +
    `\n` +
    `  ${c("── Session Commands — /vela <cmd> ───────────")}\n` +
    `    start "<req>" [--scale SCALE] [--preset PRESET]\n` +
    `                          Start a new pipeline\n` +
    `    status                Show current step and state\n` +
    `    transition            Advance to next step\n` +
    `    record <pass|fail|reject> [--summary TEXT]\n` +
    `                          Record step verdict\n` +
    `    sub-transition        Advance TDD sub-phase\n` +
    `    branch [--mode auto|prompt|none]\n` +
    `                          Create feature branch\n` +
    `    commit [--message TEXT]\n` +
    `                          Commit pipeline changes\n` +
    `    dispatch [--role ROLE]\n` +
    `                          Run agent for current step\n` +
    `    sprint run|status|create|list\n` +
    `                          Sprint orchestration\n` +
    `    analyze [--step STEP] Run analysis agent\n` +
    `    auto                  Toggle auto-advance mode\n` +
    `    history               Show pipeline history\n` +
    `    cancel                Cancel active pipeline\n` +
    `    help                  Show in-session help\n` +
    `\n` +
    `  ${c("── Scales ───────────────────────────────────")}\n` +
    `    small   trivial   init→execute→commit→finalize (4 steps)\n` +
    `    medium  quick     + plan, verify (6 steps)\n` +
    `    large   standard  full 12-step pipeline\n` +
    `    ralph   TDD loop  execute↔verify up to 10×\n` +
    `    hotfix            init→execute→commit (docs/config only)\n` +
    `\n`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const cliFlags = parseCliArgs(process.argv);
const isPrintMode = cliFlags.print === true || cliFlags.mode !== undefined;

// TTY check
if (!process.stdin.isTTY && !isPrintMode && cliFlags.listModels === undefined) {
  process.stderr.write(
    `[${APP_NAME}] Error: Interactive mode requires a terminal (TTY).\n` +
      `[${APP_NAME}] Non-interactive alternatives:\n` +
      `[${APP_NAME}]   ${APP_NAME} --print "your message"\n` +
      `[${APP_NAME}]   ${APP_NAME} --mode rpc\n`
  );
  process.exit(1);
}

// V8 compile cache (Node 22+)
if (parseInt(process.versions.node) >= 22) {
  process.env.NODE_COMPILE_CACHE ??= join(agentDir, ".compile-cache");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const authFilePath = join(agentDir, "auth.json");
const authStorage = AuthStorage.create(authFilePath);

// ─── API key validation ───────────────────────────────────────────────────────

if (cliFlags.listModels === undefined && !isPrintMode) {
  const hasEnvKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY;

  if (!hasEnvKey && !existsSync(authFilePath)) {
    process.stderr.write(
      `\n[vela] No API key found.\n` +
        `  Set an environment variable, e.g.:\n` +
        `    export ANTHROPIC_API_KEY=sk-ant-...\n` +
        `  Or run: vela --setup-auth (coming soon)\n\n`
    );
    // Non-fatal: continue and let pi-coding-agent handle the error
  }
}

// ─── Session Manager ──────────────────────────────────────────────────────────

let sessionManager: SessionManager;
if (cliFlags.noSession) {
  sessionManager = SessionManager.inMemory();
} else if (cliFlags._selectedSessionPath) {
  sessionManager = SessionManager.open(cliFlags._selectedSessionPath);
} else if (cliFlags.continue) {
  sessionManager = SessionManager.continueRecent(process.cwd());
} else {
  sessionManager = SessionManager.create(process.cwd());
}

// ─── Resolve --append-system-prompt ───────────────────────────────────────────

let appendSystemPrompt: string | undefined;
if (cliFlags.appendSystemPrompt) {
  try {
    appendSystemPrompt = existsSync(cliFlags.appendSystemPrompt)
      ? readFileSync(cliFlags.appendSystemPrompt, "utf-8")
      : cliFlags.appendSystemPrompt;
  } catch {
    appendSystemPrompt = cliFlags.appendSystemPrompt;
  }
}

// ─── Extension Paths ──────────────────────────────────────────────────────────

const additionalExtensionPaths: string[] = [];
if (velaExtPath && existsSync(velaExtPath)) {
  additionalExtensionPaths.push(velaExtPath);
}
for (const extPath of cliFlags.extensions) {
  if (existsSync(extPath)) additionalExtensionPaths.push(extPath);
}

// ─── Runtime Factory ──────────────────────────────────────────────────────────
// createAgentSessionRuntime expects a factory that builds services + session.
// The factory is reused on /new, /resume, and /fork flows inside the runtime.

const createRuntime = async ({
  cwd,
  agentDir: runtimeAgentDir,
  sessionManager: runtimeSessionManager,
  sessionStartEvent,
}: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionStartEvent?: any;
}) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: runtimeAgentDir,
    authStorage,
    resourceLoaderOptions: {
      additionalExtensionPaths:
        additionalExtensionPaths.length > 0 ? additionalExtensionPaths : undefined,
      appendSystemPrompt,
    },
  });

  // Quiet Vela-branded startup
  const { settingsManager } = services;
  if (!settingsManager.getQuietStartup()) settingsManager.setQuietStartup(true);
  if (!settingsManager.getCollapseChangelog()) settingsManager.setCollapseChangelog(true);

  const created = await createAgentSessionFromServices({
    services,
    sessionManager: runtimeSessionManager,
    sessionStartEvent,
  });

  return {
    ...created,
    services,
    diagnostics: services.diagnostics,
  };
};

// ─── Create Runtime ───────────────────────────────────────────────────────────

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir,
  sessionManager,
});

const typedRuntime = runtime as unknown as VelaRuntime;
const { session, modelFallbackMessage } = runtime;

// Log non-fatal extension errors
for (const diagnostic of typedRuntime.diagnostics) {
  if (diagnostic.type === "error") {
    process.stderr.write(`[${APP_NAME}] ${diagnostic.message}\n`);
  }
}

// ─── --list-models ────────────────────────────────────────────────────────────

if (cliFlags.listModels !== undefined) {
  const modelRegistry = typedRuntime.services.modelRegistry;
  const models = modelRegistry.getAvailable();
  if (models.length === 0) {
    console.log("No models available. Set ANTHROPIC_API_KEY or configure auth.json.");
    await typedRuntime.dispose();
    process.exit(0);
  }

  const searchPattern =
    typeof cliFlags.listModels === "string" ? cliFlags.listModels : undefined;
  let filtered = models;
  if (searchPattern) {
    const q = searchPattern.toLowerCase();
    filtered = models.filter((m) =>
      `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q)
    );
  }
  filtered.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)
  );

  const hdrs = ["provider", "model", "name"];
  const rows = filtered.map((m) => [m.provider, m.id, m.name]);
  const widths = hdrs.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(hdrs.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
  await typedRuntime.dispose();
  process.exit(0);
}

// ─── Apply --model override ───────────────────────────────────────────────────

if (cliFlags.model) {
  const modelRegistry = typedRuntime.services.modelRegistry;
  const available = modelRegistry.getAvailable();
  const match =
    available.find((m) => m.id === cliFlags.model) ??
    available.find((m) => `${m.provider}/${m.id}` === cliFlags.model);
  if (match) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await session.setModel(match as any);
    } catch {
      // non-fatal
    }
  }
}

// ─── Print / RPC Mode ─────────────────────────────────────────────────────────

if (isPrintMode) {
  const mode = cliFlags.mode ?? "text";

  if (mode === "rpc") {
    await runRpcMode(runtime);
    await typedRuntime.dispose();
    process.exit(0);
  }

  const initialMessage = cliFlags.messages[0];
  await runPrintMode(runtime, {
    mode: mode === "json" ? "json" : "text",
    initialMessage,
    messages: cliFlags.messages.slice(1),
  });
  await typedRuntime.dispose();
  process.exit(0);
}

// ─── Interactive TUI Mode ─────────────────────────────────────────────────────

const initialMessage =
  cliFlags.messages.length > 0 ? cliFlags.messages.join(" ") : undefined;

const interactiveMode = new InteractiveMode(runtime, {
  modelFallbackMessage,
  initialMessage,
  verbose: cliFlags.verbose === true,
});

await interactiveMode.run();
await typedRuntime.dispose();
process.exit(0);
