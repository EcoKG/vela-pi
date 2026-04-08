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
export {};
//# sourceMappingURL=cli.d.ts.map