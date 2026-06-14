import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { git } from "./git.js";
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
