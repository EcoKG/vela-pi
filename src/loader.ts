#!/usr/bin/env node
/**
 * Vela-Pi Startup Loader
 *
 * Standalone entry point — no GSD/gsd-pi dependency.
 * Uses @mariozechner/pi-coding-agent directly.
 *
 * Responsibilities:
 *   1. Set PI_PACKAGE_DIR → vela-pi/pkg/ (piConfig: name=vela, configDir=.vela)
 *   2. Set PI_APP_NAME → "vela"
 *   3. Set PI_CODING_AGENT_DIR → ~/.vela/agent
 *   4. Delegate to cli.js (which wires the Vela extension via additionalExtensionPaths)
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ───────────────────────────────────────────────────────────────────

const velaRoot = resolve(__dirname, "..");

// ─── PI_PACKAGE_DIR — must be set before any @mariozechner/pi-coding-agent import ──
// Must point to @mariozechner/pi-coding-agent package root so that
// getBuiltinThemes() can resolve dist/modes/interactive/theme/*.json
//
// We cannot use require.resolve("@mariozechner/pi-coding-agent/package.json")
// because the package's "exports" field does not expose ./package.json.
// Instead, resolve the main entry and extract the package root from the path.
const piAgentMain = createRequire(import.meta.url).resolve("@mariozechner/pi-coding-agent");
const piAgentNeedle = join("node_modules", "@mariozechner", "pi-coding-agent");
const piAgentCut = piAgentMain.indexOf(piAgentNeedle);
process.env.PI_PACKAGE_DIR = piAgentCut >= 0
  ? piAgentMain.slice(0, piAgentCut + piAgentNeedle.length)
  : dirname(piAgentMain);
process.env.PI_APP_NAME = "vela";
process.title = "vela";

// ─── PI_CODING_AGENT_DIR — ~/.vela/agent ─────────────────────────────────────
const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
process.env.PI_CODING_AGENT_DIR = join(homeDir, ".vela", "agent");

// ─── Fast-path: --version / --help ───────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") {
  const req = createRequire(import.meta.url);
  const pkg = req(join(velaRoot, "package.json")) as { version: string };
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

// ─── Node version check ───────────────────────────────────────────────────────
const MIN_NODE_MAJOR = 22;
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `\nError: Vela requires Node.js >= ${MIN_NODE_MAJOR}.0.0\n` +
      `       You are running Node.js ${process.versions.node}\n\n`
  );
  process.exit(1);
}

// ─── VELA_EXT_PATH — pass Vela extension path to cli.js ──────────────────────
// cli.js picks this up and passes it as additionalExtensionPaths to
// DefaultResourceLoader — no env var magic needed in pi-mono.
const velaExtPath = join(velaRoot, "dist", "resources", "extensions", "vela", "index.js");
process.env.VELA_EXT_PATH = velaExtPath;

// ─── Delegate to standalone CLI ──────────────────────────────────────────────
await import("./cli.js");
