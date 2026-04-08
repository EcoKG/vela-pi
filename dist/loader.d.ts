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
export {};
//# sourceMappingURL=loader.d.ts.map