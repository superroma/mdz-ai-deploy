import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { git, isAncestor } from "./git.js";
import type { SyncConfig } from "./config.js";

export async function ensureExclusions(cfg: SyncConfig): Promise<void> {
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
