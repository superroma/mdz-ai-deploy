import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFromEnv, type SyncConfig } from "../src/config.js";
import { ensureExclusions, commitLocal } from "../src/sync.js";
import { git } from "../src/git.js";
import { makeRepos } from "./helpers.js";

function cfgFor(workDir: string): SyncConfig {
  return {
    repoDir: workDir, remote: "origin", branch: "main",
    botName: "mdz-bot", botEmail: "bot@mdz.local",
    excludePaths: [".auth/"], commitDebounceMs: 5000, pollIntervalMs: 45000,
  };
}

describe("loadConfigFromEnv", () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD }; });
  afterEach(() => { process.env = OLD; });

  it("reads required values and applies defaults", () => {
    process.env.SYNC_REPO_DIR = "/data/repo";
    const cfg = loadConfigFromEnv();
    expect(cfg.repoDir).toBe("/data/repo");
    expect(cfg.remote).toBe("origin");
    expect(cfg.branch).toBe("main");
    expect(cfg.excludePaths).toEqual([".auth/"]);
    expect(cfg.commitDebounceMs).toBe(5000);
    expect(cfg.pollIntervalMs).toBe(45000);
  });

  it("throws when SYNC_REPO_DIR is missing", () => {
    delete process.env.SYNC_REPO_DIR;
    expect(() => loadConfigFromEnv()).toThrow(/SYNC_REPO_DIR/);
  });

  it("parses excludePaths from a comma list", () => {
    process.env.SYNC_REPO_DIR = "/data/repo";
    process.env.SYNC_EXCLUDE = ".auth/, .secrets/";
    expect(loadConfigFromEnv().excludePaths).toEqual([".auth/", ".secrets/"]);
  });
});

describe("commitLocal", () => {
  let repos: Awaited<ReturnType<typeof makeRepos>>;
  beforeEach(async () => { repos = await makeRepos(); });
  afterEach(() => repos.cleanup());

  it("commits new files as the bot and returns true", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    writeFileSync(join(repos.workDir, "page.md"), "# hello");
    expect(await commitLocal(cfg)).toBe(true);
    expect(await git(repos.workDir, ["log", "-1", "--format=%an"])).toBe("mdz-bot");
    expect(await git(repos.workDir, ["log", "-1", "--format=%s"])).toMatch(/Auto-save/);
  });

  it("returns false when there is nothing to commit", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    expect(await commitLocal(cfg)).toBe(false);
  });

  it("never commits excluded paths", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    mkdirSync(join(repos.workDir, ".auth"), { recursive: true });
    writeFileSync(join(repos.workDir, ".auth", "tokens.json"), "{secret}");
    expect(await commitLocal(cfg)).toBe(false); // excluded => nothing to commit
    writeFileSync(join(repos.workDir, "page.md"), "x");
    await commitLocal(cfg);
    const tracked = await git(repos.workDir, ["ls-files"]);
    expect(tracked).not.toMatch(/\.auth/);
    expect(tracked).toMatch(/page\.md/);
  });
});
