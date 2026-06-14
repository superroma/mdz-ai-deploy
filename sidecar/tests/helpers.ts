import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export async function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), "mdz-sync-"));
  const originDir = join(root, "origin.git");
  const workDir = join(root, "work");

  await execa("git", ["init", "--bare", "-b", "main", originDir]);
  await execa("git", ["clone", originDir, workDir]);
  await execa("git", ["-C", workDir, "config", "user.name", "seed"]);
  await execa("git", ["-C", workDir, "config", "user.email", "seed@test.local"]);
  // seed an initial commit so HEAD and origin/main exist
  await execa("git", ["-C", workDir, "commit", "--allow-empty", "-m", "init"]);
  await execa("git", ["-C", workDir, "push", "origin", "main"]);

  // a second clone to simulate "someone else" (or GitHub) editing
  const otherDir = join(root, "other");
  await execa("git", ["clone", originDir, otherDir]);
  await execa("git", ["-C", otherDir, "config", "user.name", "other"]);
  await execa("git", ["-C", otherDir, "config", "user.email", "other@test.local"]);

  return {
    root,
    originDir,
    workDir,
    otherDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
