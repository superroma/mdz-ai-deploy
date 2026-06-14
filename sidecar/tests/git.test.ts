import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { git, isAncestor } from "../src/git.js";
import { makeRepos } from "./helpers.js";

describe("git runner", () => {
  let repos: Awaited<ReturnType<typeof makeRepos>>;
  beforeEach(async () => { repos = await makeRepos(); });
  afterEach(() => repos.cleanup());

  it("returns trimmed stdout", async () => {
    const head = await git(repos.workDir, ["rev-parse", "HEAD"]);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("throws on a failing git command", async () => {
    await expect(git(repos.workDir, ["rev-parse", "does-not-exist"])).rejects.toThrow();
  });

  it("isAncestor is true for HEAD~ -> HEAD and false otherwise", async () => {
    writeFileSync(join(repos.workDir, "a.txt"), "a");
    await execa("git", ["-C", repos.workDir, "add", "-A"]);
    await execa("git", ["-C", repos.workDir, "commit", "-m", "second"]);
    const head = await git(repos.workDir, ["rev-parse", "HEAD"]);
    const prev = await git(repos.workDir, ["rev-parse", "HEAD~1"]);
    expect(await isAncestor(repos.workDir, prev, head)).toBe(true);
    expect(await isAncestor(repos.workDir, head, prev)).toBe(false);
  });

  it("throws on an invalid ref instead of silently returning false", async () => {
    const head = await git(repos.workDir, ["rev-parse", "HEAD"]);
    await expect(isAncestor(repos.workDir, "does-not-exist", head)).rejects.toThrow();
  });
});
