/**
 * Vela Slash Commands — Phase 2
 *
 * /vela start "<request>"        — initialise a new pipeline
 * /vela status                   — show current pipeline state
 * /vela transition               — advance to next step
 * /vela record <pass|fail|reject> [--summary TEXT]  — record step verdict
 * /vela sub-transition           — advance TDD sub-phase
 * /vela branch [--mode auto|prompt|none]            — create feature branch
 * /vela commit [--message TEXT]  — commit pipeline changes
 * /vela history                  — list pipeline history
 * /vela auto                     — toggle auto mode
 * /vela cancel                   — cancel the active pipeline
 * /vela help                     — show usage
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export declare function registerVelaCommands(pi: ExtensionAPI): void;
//# sourceMappingURL=commands.d.ts.map