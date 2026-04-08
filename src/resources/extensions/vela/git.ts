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

import { execFileSync } from "node:child_process";
import { PROTECTED_BRANCHES } from "./pipeline.js";

// ─── Internal helper ─────────────────────────────────────────────────────────

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).toString();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitStatusResult {
  isClean: boolean;
  dirtyFiles: string[];      // tracked files with modifications (staged or unstaged)
  untrackedFiles: string[];  // files listed with '??' prefix
}

// ─── getGitStatus ─────────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain` into a typed result.
 *
 * Each line of porcelain output is two characters of status followed by a
 * space and the file path.  Lines starting with '??' are untracked; all
 * others are dirty (modified, staged, renamed, …).
 */
export function getGitStatus(cwd: string): GitStatusResult {
  let raw: string;
  try {
    raw = git(cwd, "status", "--porcelain");
  } catch {
    return { isClean: false, dirtyFiles: [], untrackedFiles: [] };
  }

  const lines = raw.split("\n").filter((l) => l.length > 0);
  const dirtyFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of lines) {
    const xy = line.slice(0, 2);
    const filePath = line.slice(3);
    if (xy === "??") {
      untrackedFiles.push(filePath);
    } else {
      dirtyFiles.push(filePath);
    }
  }

  return {
    isClean: lines.length === 0,
    dirtyFiles,
    untrackedFiles,
  };
}

// ─── pushBranch ───────────────────────────────────────────────────────────────

/**
 * Push a branch to origin, optionally setting the upstream tracking reference.
 *
 * Runs: git push [-u origin <branch>] or [git push origin <branch>]
 */
export function pushBranch(
  cwd: string,
  branch: string,
  setUpstream = true,
): { ok: boolean; error?: string } {
  try {
    if (setUpstream) {
      git(cwd, "push", "-u", "origin", branch);
    } else {
      git(cwd, "push", "origin", branch);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── stashChanges ─────────────────────────────────────────────────────────────

/**
 * Stash the current working-tree changes.
 *
 * Runs: git stash push [-m <message>]
 * Captures and returns the stash ref (e.g. "stash@{0}") when possible.
 */
export function stashChanges(
  cwd: string,
  message?: string,
): { ok: boolean; ref?: string; error?: string } {
  try {
    const args = ["stash", "push"];
    if (message) {
      args.push("-m", message);
    }
    const output = git(cwd, ...args).trim();

    // Extract stash ref from output such as "Saved working directory … stash@{0}"
    const match = output.match(/stash@\{\d+\}/);
    const ref = match ? match[0] : undefined;
    return { ok: true, ref };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── popStash ─────────────────────────────────────────────────────────────────

/**
 * Pop the top (or a specific) stash entry.
 *
 * Runs: git stash pop [ref]
 */
export function popStash(
  cwd: string,
  ref?: string,
): { ok: boolean; error?: string } {
  try {
    if (ref) {
      git(cwd, "stash", "pop", ref);
    } else {
      git(cwd, "stash", "pop");
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── detectMainBranch ─────────────────────────────────────────────────────────

/**
 * Detect the primary integration branch of the repository.
 *
 * Tries "main" first, then "master".  Returns the first branch that resolves
 * via `git rev-parse --verify`, or null if neither exists.
 */
export function detectMainBranch(cwd: string): string | null {
  for (const candidate of ["main", "master"]) {
    try {
      git(cwd, "rev-parse", "--verify", candidate);
      return candidate;
    } catch {
      // branch doesn't exist — try next
    }
  }
  return null;
}

// ─── isProtectedBranch ────────────────────────────────────────────────────────

/**
 * Return true when the branch name is in the PROTECTED_BRANCHES list
 * (main, master, develop) imported from pipeline.ts.
 */
export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(branch);
}

// ─── getCurrentBranch ─────────────────────────────────────────────────────────

/**
 * Return the current checked-out branch name, or null on any error
 * (detached HEAD, not a git repo, etc.).
 */
export function getCurrentBranch(cwd: string): string | null {
  try {
    const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();
    // "HEAD" is returned in detached state — treat as null
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

// ─── getDiffPatch ─────────────────────────────────────────────────────────────

/**
 * Return the diff output from `fromRef` to HEAD, or `git diff HEAD` when
 * no fromRef is supplied (shows unstaged + staged changes relative to HEAD).
 *
 * Returns an empty string on any error.
 */
export function getDiffPatch(cwd: string, fromRef?: string): string {
  try {
    if (fromRef) {
      return git(cwd, "diff", `${fromRef}..HEAD`);
    }
    return git(cwd, "diff", "HEAD");
  } catch {
    return "";
  }
}

// ─── listMergedVelaBranches ───────────────────────────────────────────────────

/**
 * List all local `vela/*` branches that have been merged into the current
 * branch and are not main, master, or the currently checked-out branch.
 *
 * Uses `git branch --merged` to find merged branches, then filters to those
 * matching the `vela/` prefix while excluding protected and current branches.
 */
export function listMergedVelaBranches(cwd: string): string[] {
  const currentBranch = getCurrentBranch(cwd);

  let raw: string;
  try {
    raw = git(cwd, "branch", "--merged");
  } catch {
    return [];
  }

  return raw
    .split("\n")
    .map((l) => l.replace(/^\*?\s+/, "").trim())
    .filter((b) => {
      if (!b.startsWith("vela/")) return false;
      if (PROTECTED_BRANCHES.includes(b)) return false;
      if (currentBranch && b === currentBranch) return false;
      return true;
    });
}
