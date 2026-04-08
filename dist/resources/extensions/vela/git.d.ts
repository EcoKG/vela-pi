/**
 * Vela Git Integration — Phase 5
 *
 * Dedicated git helper module providing missing pieces beyond the
 * snapshotGitState / createPipelineBranch / commitPipeline already in pipeline.ts.
 *
 * All operations use execFileSync("git", [...]) with a consistent set of
 * options: { cwd, stdio: ["pipe","pipe","pipe"], timeout: 15000 }.
 * Operations that can fail return { ok: false, error } and never throw.
 */
export interface GitStatusResult {
    isClean: boolean;
    dirtyFiles: string[];
    untrackedFiles: string[];
}
/**
 * Parse `git status --porcelain` into a typed result.
 *
 * Each line of porcelain output is two characters of status followed by a
 * space and the file path.  Lines starting with '??' are untracked; all
 * others are dirty (modified, staged, renamed, …).
 */
export declare function getGitStatus(cwd: string): GitStatusResult;
/**
 * Push a branch to origin, optionally setting the upstream tracking reference.
 *
 * Runs: git push [-u origin <branch>] or [git push origin <branch>]
 */
export declare function pushBranch(cwd: string, branch: string, setUpstream?: boolean): {
    ok: boolean;
    error?: string;
};
/**
 * Stash the current working-tree changes.
 *
 * Runs: git stash push [-m <message>]
 * Captures and returns the stash ref (e.g. "stash@{0}") when possible.
 */
export declare function stashChanges(cwd: string, message?: string): {
    ok: boolean;
    ref?: string;
    error?: string;
};
/**
 * Pop the top (or a specific) stash entry.
 *
 * Runs: git stash pop [ref]
 */
export declare function popStash(cwd: string, ref?: string): {
    ok: boolean;
    error?: string;
};
/**
 * Detect the primary integration branch of the repository.
 *
 * Tries "main" first, then "master".  Returns the first branch that resolves
 * via `git rev-parse --verify`, or null if neither exists.
 */
export declare function detectMainBranch(cwd: string): string | null;
/**
 * Return true when the branch name is in the PROTECTED_BRANCHES list
 * (main, master, develop) imported from pipeline.ts.
 */
export declare function isProtectedBranch(branch: string): boolean;
/**
 * Return the current checked-out branch name, or null on any error
 * (detached HEAD, not a git repo, etc.).
 */
export declare function getCurrentBranch(cwd: string): string | null;
/**
 * Return the diff output from `fromRef` to HEAD, or `git diff HEAD` when
 * no fromRef is supplied (shows unstaged + staged changes relative to HEAD).
 *
 * Returns an empty string on any error.
 */
export declare function getDiffPatch(cwd: string, fromRef?: string): string;
/**
 * List all local `vela/*` branches that have been merged into the current
 * branch and are not main, master, or the currently checked-out branch.
 *
 * Uses `git branch --merged` to find merged branches, then filters to those
 * matching the `vela/` prefix while excluding protected and current branches.
 */
export declare function listMergedVelaBranches(cwd: string): string[];
//# sourceMappingURL=git.d.ts.map