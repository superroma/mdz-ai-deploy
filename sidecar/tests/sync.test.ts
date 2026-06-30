import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { loadConfigFromEnv, type SyncConfig } from "../src/config.js";
import { ensureExclusions, commitLocal, pullRemote, pushIfAhead, syncOnce, createSyncer } from "../src/sync.js";
import { git } from "../src/git.js";
import { makeRepos } from "./helpers.js";

function cfgFor(workDir: string): SyncConfig {
  return {
    repoDir: workDir, remote: "origin", branch: "main",
    botName: "mdz-bot", botEmail: "bot@mdz.local",
    excludePaths: [".auth/"], commitDebounceMs: 5000, pollIntervalMs: 45000,
  };
}

async function commitInOther(otherDir: string, file: string, body: string) {
  await execa("git", ["-C", otherDir, "pull", "--ff-only", "origin", "main"]).catch(() => {});
  writeFileSync(join(otherDir, file), body);
  await execa("git", ["-C", otherDir, "add", "-A"]);
  await execa("git", ["-C", otherDir, "commit", "-m", `other ${file}`]);
  await execa("git", ["-C", otherDir, "push", "origin", "main"]);
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
    expect(cfg.excludePaths).toEqual([".auth/", ".settings/"]);
    expect(cfg.commitDebounceMs).toBe(5000);
    expect(cfg.pollIntervalMs).toBe(45000);
  });

  it("falls back to defaults for non-numeric or non-positive intervals", () => {
    process.env.SYNC_REPO_DIR = "/data/repo";
    process.env.SYNC_DEBOUNCE_MS = "0";
    process.env.SYNC_POLL_MS = "abc";
    const cfg = loadConfigFromEnv();
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

  it("creates .git/info/exclude when the info dir is missing", async () => {
    const cfg = cfgFor(repos.workDir);
    rmSync(join(repos.workDir, ".git", "info"), { recursive: true, force: true });
    await ensureExclusions(cfg);
    const content = readFileSync(join(repos.workDir, ".git", "info", "exclude"), "utf8");
    expect(content).toMatch(/\.auth\//);
  });

  it("never runs a repo-provided pre-commit hook (security: planted .git/hooks)", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    const hook = join(repos.workDir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");        // a hook that would ABORT the commit if run
    chmodSync(hook, 0o755);
    writeFileSync(join(repos.workDir, "page.md"), "# hello");
    expect(await commitLocal(cfg)).toBe(true);          // commit succeeds => hook was NOT executed
  });
});

describe("pullRemote / pushIfAhead", () => {
  let repos: Awaited<ReturnType<typeof makeRepos>>;
  beforeEach(async () => { repos = await makeRepos(); });
  afterEach(() => repos.cleanup());

  it("reports up-to-date when nothing changed remotely", async () => {
    const cfg = cfgFor(repos.workDir);
    expect(await pullRemote(cfg)).toBe("up-to-date");
  });

  it("pulls remote changes into the working tree", async () => {
    const cfg = cfgFor(repos.workDir);
    await commitInOther(repos.otherDir, "remote.md", "from-remote");
    expect(await pullRemote(cfg)).toBe("updated");
    expect(readFileSync(join(repos.workDir, "remote.md"), "utf8")).toBe("from-remote");
  });

  it("remote wins on a true conflict", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    writeFileSync(join(repos.workDir, "conflict.md"), "LOCAL");
    await commitLocal(cfg);
    await commitInOther(repos.otherDir, "conflict.md", "REMOTE");
    const result = await pullRemote(cfg);
    expect(["updated", "reset"]).toContain(result);
    expect(readFileSync(join(repos.workDir, "conflict.md"), "utf8")).toBe("REMOTE");
  });

  it("pushes local commits that are ahead of remote", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    writeFileSync(join(repos.workDir, "mine.md"), "mine");
    await commitLocal(cfg);
    expect(await pushIfAhead(cfg)).toBe(true);
    await execa("git", ["-C", repos.otherDir, "pull", "--ff-only", "origin", "main"]);
    expect(readFileSync(join(repos.otherDir, "mine.md"), "utf8")).toBe("mine");
  });
});

describe("syncOnce", () => {
  let repos: Awaited<ReturnType<typeof makeRepos>>;
  beforeEach(async () => { repos = await makeRepos(); });
  afterEach(() => repos.cleanup());

  it("commits local + pushes, and pulls remote, in one pass", async () => {
    const cfg = cfgFor(repos.workDir);
    await ensureExclusions(cfg);
    writeFileSync(join(repos.workDir, "local.md"), "local");
    await commitInOther(repos.otherDir, "remote.md", "remote");
    await syncOnce(cfg);
    expect(readFileSync(join(repos.workDir, "remote.md"), "utf8")).toBe("remote");
    await execa("git", ["-C", repos.otherDir, "fetch", "origin", "main"]);
    const originFiles = await git(repos.otherDir, ["ls-tree", "--name-only", "origin/main"]);
    expect(originFiles).toMatch(/local\.md/);
  });
});

describe("createSyncer", () => {
  it("coalesces concurrent requests into at most one pending re-run", async () => {
    let active = 0, max = 0, runs = 0;
    const slow = () => new Promise<void>((res) => {
      runs++; active++; max = Math.max(max, active);
      setTimeout(() => { active--; res(); }, 30);
    });
    const cfg = cfgFor("/unused");
    const syncer = createSyncer(cfg, slow);
    await Promise.all([syncer.request(), syncer.request(), syncer.request(), syncer.request(), syncer.request()]);
    expect(max).toBe(1);
    expect(runs).toBe(2);
  });

  it("runs the pending re-run even when a run throws, and reports the error", async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const flaky = () => new Promise<void>((res, rej) => {
      runs++;
      setTimeout(() => (runs === 1 ? rej(new Error("boom")) : res()), 20);
    });
    const cfg = cfgFor("/unused");
    const syncer = createSyncer(cfg, flaky, (e) => errors.push(e));
    await Promise.all([syncer.request(), syncer.request()]);
    expect(runs).toBe(2);          // pending re-run survived the throw
    expect(errors).toHaveLength(1); // the failure was reported, not dropped
  });
});
