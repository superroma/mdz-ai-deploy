import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { git, isAncestor } from "./git.js";
import type { SyncConfig } from "./config.js";

export async function ensureExclusions(cfg: SyncConfig): Promise<void> {
  // Adds excludePaths to .git/info/exclude so they are never staged or committed.
  // NOTE: this only affects UNTRACKED paths. Anything already tracked (e.g. if a
  // secret was ever committed) keeps syncing — excluded paths must never be committed.
  const excludeFile = join(cfg.repoDir, ".git", "info", "exclude");
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  const lines = new Set(current.split("\n").map((l) => l.trim()).filter(Boolean));
  const toAdd = cfg.excludePaths.filter((p) => !lines.has(p));
  if (toAdd.length) appendFileSync(excludeFile, "\n" + toAdd.join("\n") + "\n");
}

export async function commitLocal(cfg: SyncConfig): Promise<boolean> {
  const status = await git(cfg.repoDir, ["status", "--porcelain"]);
  if (!status.trim()) return false;
  await git(cfg.repoDir, ["add", "-A"]);
  // double-check something is actually staged (e.g. only-excluded edge cases)
  const staged = await git(cfg.repoDir, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return false;
  const msg = `Auto-save ${new Date().toISOString()}`;
  await execa("git", [
    "-C", cfg.repoDir,
    "-c", `user.name=${cfg.botName}`,
    "-c", `user.email=${cfg.botEmail}`,
    "commit", "-m", msg,
  ]);
  return true;
}

export async function pullRemote(
  cfg: SyncConfig
): Promise<"up-to-date" | "updated" | "reset"> {
  await git(cfg.repoDir, ["fetch", cfg.remote, cfg.branch]);
  const local = await git(cfg.repoDir, ["rev-parse", "HEAD"]);
  const remoteRef = `${cfg.remote}/${cfg.branch}`;
  const remote = await git(cfg.repoDir, ["rev-parse", remoteRef]);
  if (local === remote) return "up-to-date";
  // strictly ahead (remote is an ancestor of local): nothing to merge
  if (await isAncestor(cfg.repoDir, remote, local)) return "up-to-date";
  try {
    await execa("git", [
      "-C", cfg.repoDir,
      "-c", `user.name=${cfg.botName}`,
      "-c", `user.email=${cfg.botEmail}`,
      "merge", "--no-edit", "--strategy-option=theirs", remoteRef,
    ]);
    return "updated";
  } catch {
    // "Remote wins": a conflict that -X theirs cannot auto-resolve (e.g.
    // modify/delete) falls back to a hard reset onto the remote. NOTE: this also
    // discards any *uncommitted* local edits made in the small window since
    // commitLocal ran. Accepted tradeoff — GitHub is canonical, local is a workspace.
    await git(cfg.repoDir, ["merge", "--abort"]).catch(() => {});
    await git(cfg.repoDir, ["reset", "--hard", remoteRef]);
    return "reset";
  }
}

export async function pushIfAhead(cfg: SyncConfig): Promise<boolean> {
  const local = await git(cfg.repoDir, ["rev-parse", "HEAD"]);
  const remote = await git(cfg.repoDir, ["rev-parse", `${cfg.remote}/${cfg.branch}`]);
  if (local === remote) return false;
  if (await isAncestor(cfg.repoDir, remote, local)) {
    await git(cfg.repoDir, ["push", cfg.remote, `HEAD:${cfg.branch}`]);
    return true;
  }
  return false;
}

export async function syncOnce(cfg: SyncConfig): Promise<void> {
  await commitLocal(cfg);
  await pullRemote(cfg);
  await pushIfAhead(cfg);
}

export function createSyncer(
  cfg: SyncConfig,
  runOnce: () => Promise<void> = () => syncOnce(cfg),
  onError: (err: unknown) => void = (err) => console.error("[sidecar] sync failed", err)
): { request: () => Promise<void> } {
  let running = false;
  let pending = false;
  async function request(): Promise<void> {
    if (running) { pending = true; return; }
    running = true;
    try {
      do {
        pending = false;
        // Catch per-iteration so a failed run never drops a queued re-run, and
        // request() never rejects (the daemon calls it fire-and-forget).
        try {
          await runOnce();
        } catch (err) {
          onError(err);
        }
      } while (pending);
    } finally {
      running = false;
    }
  }
  return { request };
}
