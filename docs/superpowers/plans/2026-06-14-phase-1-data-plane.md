# Phase 1 — Data Plane (sync-sidecar + Compose + Caddy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an MDZ site from a GitHub content repo via Docker Compose, with a deterministic sync-sidecar that two-way-syncs the working tree to GitHub (remote-wins) and a shared Caddy proxy — no auth changes.

**Architecture:** A long-running Node sidecar shares a volume with MDZ. It debounce-commits local file changes and pushes them, and polls the remote, merging with `--strategy-option=theirs` (falling back to `reset --hard`) so a GitHub push always wins. The git logic is pure, offline-testable functions over temp repos; the daemon is a thin watch+poll loop. MDZ is built from a pinned git ref so the `mdz` repo stays untouched. Caddy terminates TLS and routes by hostname.

**Tech Stack:** Node 20 + TypeScript (run via `tsx`, no build step), `execa` (git), `chokidar` (file watch), `vitest` (tests), Docker Compose, Caddy.

---

## File structure (created in this plan)

```
mdz-ai-deploy/
├── package.json                 # Node project: tsx, execa, chokidar, vitest
├── tsconfig.json
├── vitest.config.ts
├── .gitignore                   # node_modules, .env, data/
├── sidecar/
│   ├── src/
│   │   ├── git.ts               # thin git command runner + isAncestor
│   │   ├── config.ts            # SyncConfig type + loadConfigFromEnv()
│   │   ├── sync.ts              # commitLocal, pullRemote, pushIfAhead, syncOnce, createSyncer
│   │   └── daemon.ts            # watch + poll loop wiring createSyncer
│   └── tests/
│       ├── helpers.ts           # makeRepos(): bare origin + working clone in temp dirs
│       ├── git.test.ts
│       └── sync.test.ts
├── docker/
│   ├── Dockerfile.mdz           # builds MDZ from a pinned git ref
│   └── Dockerfile.sidecar       # runs the Node sidecar via tsx
├── compose/
│   ├── docker-compose.yml       # mdz + sidecar + caddy + shared volume (templated via env)
│   ├── Caddyfile                # reverse_proxy by hostname, auto-TLS
│   └── .env.example             # all knobs for one site
└── docs/
    └── smoke-test.md            # manual end-to-end verification against a throwaway repo
```

**Interfaces locked here (used by every later task):**

```ts
// sidecar/src/config.ts
export interface SyncConfig {
  repoDir: string;        // absolute path to the git working tree (the shared volume)
  remote: string;         // e.g. "origin"
  branch: string;         // e.g. "main"
  botName: string;        // commit author name
  botEmail: string;       // commit author email
  excludePaths: string[]; // repo-relative paths never committed (e.g. [".auth/"])
  commitDebounceMs: number;
  pollIntervalMs: number;
}
```

```ts
// sidecar/src/git.ts
export function git(cwd: string, args: string[]): Promise<string>;        // stdout, throws on nonzero
export function isAncestor(cwd: string, a: string, b: string): Promise<boolean>; // true if commit a is an ancestor of b
```

```ts
// sidecar/src/sync.ts
export function ensureExclusions(cfg: SyncConfig): Promise<void>;         // write excludePaths into .git/info/exclude
export function commitLocal(cfg: SyncConfig): Promise<boolean>;           // true if a commit was created
export function pullRemote(cfg: SyncConfig): Promise<"up-to-date" | "updated" | "reset">;
export function pushIfAhead(cfg: SyncConfig): Promise<boolean>;           // true if a push happened
export function syncOnce(cfg: SyncConfig): Promise<void>;                 // commit -> pull -> push
export function createSyncer(cfg: SyncConfig, runOnce?: () => Promise<void>): { request: () => Promise<void> };
```

---

## Task 1: Scaffold the Node project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mdz-ai-deploy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "sidecar": "node --import tsx/esm sidecar/src/daemon.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "chokidar": "^3.6.0",
    "execa": "^8.0.1",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.24",
    "typescript": "5.5.4",
    "vitest": "^1.6.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["sidecar/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["sidecar/tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
.env
data/
*.log
```

- [ ] **Step 5: Install and verify**

Run: `npm install && npx vitest run`
Expected: install succeeds; vitest reports "No test files found" (exit 0) or runs 0 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold node project for sync-sidecar"
```

---

## Task 2: Git command runner

**Files:**
- Create: `sidecar/src/git.ts`
- Create: `sidecar/tests/helpers.ts`
- Test: `sidecar/tests/git.test.ts`

- [ ] **Step 1: Write the test helper (`sidecar/tests/helpers.ts`)**

```ts
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
```

- [ ] **Step 2: Write the failing test (`sidecar/tests/git.test.ts`)**

```ts
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run sidecar/tests/git.test.ts`
Expected: FAIL — cannot resolve `../src/git.js`.

- [ ] **Step 4: Implement `sidecar/src/git.ts`**

```ts
import { execa } from "execa";

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await execa("git", ["-C", cwd, "merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run sidecar/tests/git.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/git.ts sidecar/tests/git.test.ts sidecar/tests/helpers.ts
git commit -m "feat(sidecar): git command runner with isAncestor"
```

---

## Task 3: Config type + env loader

**Files:**
- Create: `sidecar/src/config.ts`
- Test: `sidecar/tests/sync.test.ts` (config section; file grows across Tasks 3–6)

- [ ] **Step 1: Write the failing test (start `sidecar/tests/sync.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../src/config.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement `sidecar/src/config.ts`**

```ts
export interface SyncConfig {
  repoDir: string;
  remote: string;
  branch: string;
  botName: string;
  botEmail: string;
  excludePaths: string[];
  commitDebounceMs: number;
  pollIntervalMs: number;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const repoDir = env.SYNC_REPO_DIR;
  if (!repoDir) throw new Error("SYNC_REPO_DIR is required");
  const excludeRaw = env.SYNC_EXCLUDE ?? ".auth/";
  return {
    repoDir,
    remote: env.SYNC_REMOTE ?? "origin",
    branch: env.SYNC_BRANCH ?? "main",
    botName: env.SYNC_BOT_NAME ?? "mdz-bot",
    botEmail: env.SYNC_BOT_EMAIL ?? "bot@mdz.local",
    excludePaths: excludeRaw.split(",").map((s) => s.trim()).filter(Boolean),
    commitDebounceMs: Number(env.SYNC_DEBOUNCE_MS ?? 5000),
    pollIntervalMs: Number(env.SYNC_POLL_MS ?? 45000),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/config.ts sidecar/tests/sync.test.ts
git commit -m "feat(sidecar): SyncConfig and env loader"
```

---

## Task 4: Exclusions + commitLocal

**Files:**
- Create: `sidecar/src/sync.ts`
- Modify: `sidecar/tests/sync.test.ts` (append a describe block)

- [ ] **Step 1: Add failing tests (append to `sidecar/tests/sync.test.ts`)**

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureExclusions, commitLocal } from "../src/sync.js";
import { git } from "../src/git.js";
import { makeRepos } from "./helpers.js";
import type { SyncConfig } from "../src/config.js";

function cfgFor(workDir: string): SyncConfig {
  return {
    repoDir: workDir, remote: "origin", branch: "main",
    botName: "mdz-bot", botEmail: "bot@mdz.local",
    excludePaths: [".auth/"], commitDebounceMs: 5000, pollIntervalMs: 45000,
  };
}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: FAIL — cannot resolve `../src/sync.js`.

- [ ] **Step 3: Implement `sidecar/src/sync.ts` (exclusions + commitLocal)**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: PASS (config + commitLocal blocks).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/sync.ts sidecar/tests/sync.test.ts
git commit -m "feat(sidecar): ensureExclusions and commitLocal"
```

---

## Task 5: pullRemote (remote-wins) + pushIfAhead

**Files:**
- Modify: `sidecar/src/sync.ts` (add `pullRemote`, `pushIfAhead`)
- Modify: `sidecar/tests/sync.test.ts` (append a describe block)

- [ ] **Step 1: Add failing tests (append to `sidecar/tests/sync.test.ts`)**

```ts
import { pullRemote, pushIfAhead } from "../src/sync.js";
import { readFileSync } from "node:fs";
import { execa } from "execa";

async function commitInOther(otherDir: string, file: string, body: string) {
  await execa("git", ["-C", otherDir, "pull", "--ff-only", "origin", "main"]).catch(() => {});
  writeFileSync(join(otherDir, file), body);
  await execa("git", ["-C", otherDir, "add", "-A"]);
  await execa("git", ["-C", otherDir, "commit", "-m", `other ${file}`]);
  await execa("git", ["-C", otherDir, "push", "origin", "main"]);
}

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
    // a fresh clone of origin should now contain the file
    await execa("git", ["-C", repos.otherDir, "pull", "--ff-only", "origin", "main"]);
    expect(readFileSync(join(repos.otherDir, "mine.md"), "utf8")).toBe("mine");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: FAIL — `pullRemote`/`pushIfAhead` are not exported.

- [ ] **Step 3: Implement (append to `sidecar/src/sync.ts`)**

```ts
import { isAncestor } from "./git.js";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: PASS (all blocks so far).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/sync.ts sidecar/tests/sync.test.ts
git commit -m "feat(sidecar): pullRemote (remote-wins) and pushIfAhead"
```

---

## Task 6: syncOnce + createSyncer (coalescing lock)

**Files:**
- Modify: `sidecar/src/sync.ts` (add `syncOnce`, `createSyncer`)
- Modify: `sidecar/tests/sync.test.ts` (append a describe block)

- [ ] **Step 1: Add failing tests (append to `sidecar/tests/sync.test.ts`)**

```ts
import { syncOnce, createSyncer } from "../src/sync.js";

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
    // remote change landed locally
    expect(readFileSync(join(repos.workDir, "remote.md"), "utf8")).toBe("remote");
    // local change reached origin
    await execa("git", ["-C", repos.otherDir, "pull", "--ff-only", "origin", "main"]).catch(() => {});
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
    // fire 5 quickly while the first is running
    await Promise.all([syncer.request(), syncer.request(), syncer.request(), syncer.request(), syncer.request()]);
    expect(max).toBe(1);     // never overlapping
    expect(runs).toBe(2);    // first run + exactly one coalesced re-run
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: FAIL — `syncOnce`/`createSyncer` not exported.

- [ ] **Step 3: Implement (append to `sidecar/src/sync.ts`)**

```ts
export async function syncOnce(cfg: SyncConfig): Promise<void> {
  await commitLocal(cfg);
  await pullRemote(cfg);
  await pushIfAhead(cfg);
}

export function createSyncer(
  cfg: SyncConfig,
  runOnce: () => Promise<void> = () => syncOnce(cfg)
): { request: () => Promise<void> } {
  let running = false;
  let pending = false;
  async function request(): Promise<void> {
    if (running) { pending = true; return; }
    running = true;
    try {
      do {
        pending = false;
        await runOnce();
      } while (pending);
    } finally {
      running = false;
    }
  }
  return { request };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run sidecar/tests/sync.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — `git.test.ts` + `sync.test.ts`, all green.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/sync.ts sidecar/tests/sync.test.ts
git commit -m "feat(sidecar): syncOnce and coalescing createSyncer"
```

---

## Task 7: Daemon loop (watch + poll)

**Files:**
- Create: `sidecar/src/daemon.ts`

The watcher/timer loop is thin glue over the tested core; it is verified by the manual smoke test (Task 12) rather than a unit test (chokidar + real timers are integration concerns).

- [ ] **Step 1: Implement `sidecar/src/daemon.ts`**

```ts
import chokidar from "chokidar";
import { join, sep } from "node:path";
import { loadConfigFromEnv } from "./config.js";
import { ensureExclusions, createSyncer } from "./sync.js";

async function main() {
  const cfg = loadConfigFromEnv();
  await ensureExclusions(cfg);
  const syncer = createSyncer(cfg);

  console.log(`[sidecar] watching ${cfg.repoDir} (debounce ${cfg.commitDebounceMs}ms, poll ${cfg.pollIntervalMs}ms)`);

  // initial reconcile on startup
  await syncer.request();

  // poll the remote
  setInterval(() => { void syncer.request(); }, cfg.pollIntervalMs);

  // watch local changes (ignore the .git dir), debounce, then sync
  let timer: NodeJS.Timeout | undefined;
  const gitDir = join(cfg.repoDir, ".git");
  const watcher = chokidar.watch(cfg.repoDir, {
    ignored: (p: string) => p === gitDir || p.startsWith(gitDir + sep),
    ignoreInitial: true,
  });
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void syncer.request(); }, cfg.commitDebounceMs);
  });

  process.on("SIGTERM", () => { void watcher.close().then(() => process.exit(0)); });
  process.on("SIGINT", () => { void watcher.close().then(() => process.exit(0)); });
}

main().catch((err) => { console.error("[sidecar] fatal", err); process.exit(1); });
```

- [ ] **Step 2: Smoke-run the daemon locally against a temp repo**

Run:
```bash
node -e "const {execSync}=require('child_process');const os=require('os');const fs=require('fs');const p=require('path');const r=fs.mkdtempSync(p.join(os.tmpdir(),'mdz-d-'));execSync(`git init --bare -b main ${r}/o.git`);execSync(`git clone ${r}/o.git ${r}/w`);execSync(`git -C ${r}/w config user.email e@e && git -C ${r}/w config user.name e && git -C ${r}/w commit --allow-empty -m init && git -C ${r}/w push origin main`);console.log(r)"
```
Take the printed temp path `<R>`, then:
```bash
SYNC_REPO_DIR=<R>/w SYNC_DEBOUNCE_MS=1000 SYNC_POLL_MS=3000 npm run sidecar &
sleep 2 && echo "# hi" > <R>/w/page.md && sleep 3
git -C <R>/o.git log --oneline   # expect an "Auto-save ..." commit
kill %1
```
Expected: the bare origin shows an `Auto-save …` commit containing `page.md`.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/daemon.ts
git commit -m "feat(sidecar): watch+poll daemon loop"
```

---

## Task 8: Dockerfile for the sidecar

**Files:**
- Create: `docker/Dockerfile.sidecar`

- [ ] **Step 1: Implement `docker/Dockerfile.sidecar`**

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY sidecar ./sidecar
ENV SYNC_REPO_DIR=/data/repo
CMD ["node", "--import", "tsx/esm", "sidecar/src/daemon.ts"]
```

Note: `tsx` is a runtime dependency in `package.json`, so `--omit=dev` keeps it.

- [ ] **Step 2: Build to verify**

Run: `docker build -f docker/Dockerfile.sidecar -t mdz-sidecar:dev .`
Expected: image builds successfully.

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.sidecar
git commit -m "feat(docker): sidecar image"
```

---

## Task 9: Dockerfile for MDZ (build from a pinned ref)

**Files:**
- Create: `docker/Dockerfile.mdz`

Keeps the `mdz` repo untouched: clone + build at a build-arg ref.

- [ ] **Step 1: Implement `docker/Dockerfile.mdz`**

```dockerfile
# ---- build ----
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG MDZ_REPO=https://github.com/superroma/mdz
ARG MDZ_REF=main
WORKDIR /src
RUN git clone "$MDZ_REPO" . && git checkout "$MDZ_REF"
RUN npm install && npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=build /src /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001
# PAGES_ROOT is provided at runtime (the shared volume)
CMD ["npm", "run", "start", "--workspace", "@app/backend"]
```

- [ ] **Step 2: Build to verify**

Run: `docker build -f docker/Dockerfile.mdz -t mdz-app:dev .`
Expected: image builds (clones + builds MDZ). If the start command differs, confirm against `packages/backend/package.json` `start` script (`node dist/server.js`) and adjust `CMD` to `["node", "packages/backend/dist/server.js"]`.

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.mdz
git commit -m "feat(docker): build MDZ from a pinned git ref"
```

---

## Task 10: Compose project (mdz + sidecar + shared volume)

**Files:**
- Create: `compose/docker-compose.yml`
- Create: `compose/.env.example`

- [ ] **Step 1: Implement `compose/.env.example`**

```bash
# --- site identity ---
SITE_DOMAIN=mysite.example.com
MDZ_REF=main

# --- content repo ---
CONTENT_REPO=git@github.com:superroma/bridge-home.git
SYNC_BRANCH=main

# --- sync sidecar ---
SYNC_BOT_NAME=mdz-bot
SYNC_BOT_EMAIL=bot@mdz.local
SYNC_DEBOUNCE_MS=5000
SYNC_POLL_MS=45000
SYNC_EXCLUDE=.auth/

# --- MDZ ---
JWT_SECRET=change-me
PAGES_SUBDIR=pages          # PAGES_ROOT = /data/repo/${PAGES_SUBDIR}

# Path on the host to the per-site deploy key (read-only mount into the sidecar)
DEPLOY_KEY=./secrets/deploy_key
```

- [ ] **Step 2: Implement `compose/docker-compose.yml`**

```yaml
services:
  mdz:
    build:
      context: ..
      dockerfile: docker/Dockerfile.mdz
      args:
        MDZ_REF: ${MDZ_REF}
    environment:
      PAGES_ROOT: /data/repo/${PAGES_SUBDIR}
      JWT_SECRET: ${JWT_SECRET}
      PORT: "3001"
      HOST: 0.0.0.0
    volumes:
      - repo:/data/repo
    depends_on:
      sidecar:
        condition: service_started
    expose:
      - "3001"

  sidecar:
    build:
      context: ..
      dockerfile: docker/Dockerfile.sidecar
    environment:
      SYNC_REPO_DIR: /data/repo
      SYNC_BRANCH: ${SYNC_BRANCH}
      SYNC_BOT_NAME: ${SYNC_BOT_NAME}
      SYNC_BOT_EMAIL: ${SYNC_BOT_EMAIL}
      SYNC_DEBOUNCE_MS: ${SYNC_DEBOUNCE_MS}
      SYNC_POLL_MS: ${SYNC_POLL_MS}
      SYNC_EXCLUDE: ${SYNC_EXCLUDE}
      GIT_SSH_COMMAND: "ssh -i /keys/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    volumes:
      - repo:/data/repo
      - ${DEPLOY_KEY}:/keys/deploy_key:ro
    # The repo is cloned by the spawn step (Phase 3) before first boot.
    # For Phase 1 the smoke test clones it manually into the volume.

volumes:
  repo:
```

Note: actually cloning the content repo into the named volume is the spawn skill's job (Phase 3). Phase 1 verifies the mechanics via the manual smoke test below.

- [ ] **Step 3: Validate compose syntax**

Run: `cd compose && cp .env.example .env && docker compose config`
Expected: prints the resolved config with no errors.

- [ ] **Step 4: Commit**

```bash
git add compose/docker-compose.yml compose/.env.example
git commit -m "feat(compose): mdz + sidecar + shared volume"
```

---

## Task 11: Caddy edge proxy

**Files:**
- Create: `compose/Caddyfile`
- Modify: `compose/docker-compose.yml` (add the `caddy` service)

- [ ] **Step 1: Implement `compose/Caddyfile`**

```
{$SITE_DOMAIN} {
	reverse_proxy mdz:3001
}
```

For local smoke testing without DNS/TLS, override with `SITE_DOMAIN=:80` (Caddy then serves plain HTTP on port 80).

- [ ] **Step 2: Add the `caddy` service to `compose/docker-compose.yml`**

Insert this service alongside `mdz` and `sidecar`:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      SITE_DOMAIN: ${SITE_DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - mdz
```

And add to the `volumes:` block:

```yaml
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Validate compose syntax**

Run: `cd compose && docker compose config`
Expected: resolves with `caddy`, `mdz`, `sidecar` services and named volumes.

- [ ] **Step 4: Commit**

```bash
git add compose/Caddyfile compose/docker-compose.yml
git commit -m "feat(caddy): edge proxy routing domain to mdz"
```

---

## Task 12: End-to-end smoke test (manual)

**Files:**
- Create: `docs/smoke-test.md`

- [ ] **Step 1: Write `docs/smoke-test.md`**

````markdown
# Phase 1 smoke test

Verifies: MDZ serves a content repo, local edits sync to GitHub, and a GitHub
push wins (remote-wins). Uses a throwaway local bare repo as "GitHub" so no
network or real auth is needed.

## 1. Make a throwaway content repo with a `pages/` tree

```bash
R=$(mktemp -d)
git init --bare -b main "$R/origin.git"
git clone "$R/origin.git" "$R/seed"
mkdir -p "$R/seed/pages"
printf '# Welcome\n\nhello\n' > "$R/seed/pages/Welcome.md"
git -C "$R/seed" add -A
git -C "$R/seed" -c user.email=s@s -c user.name=s commit -m "seed pages"
git -C "$R/seed" push origin main
echo "ORIGIN=$R/origin.git"
```

## 2. Pre-clone into a Docker volume (Phase 3 will automate this)

```bash
docker volume create mdz_repo
docker run --rm -v mdz_repo:/data alpine/git clone "$R/origin.git" /data/repo
```

## 3. Bring up the stack against that volume

Use `SITE_DOMAIN=:80` for local HTTP. Point the compose `repo` volume at the
pre-created `mdz_repo` volume (edit compose or use `--volume`), then:

```bash
cd compose
SITE_DOMAIN=:80 JWT_SECRET=dev MDZ_REF=main PAGES_SUBDIR=pages \
  SYNC_DEBOUNCE_MS=1000 SYNC_POLL_MS=3000 \
  docker compose up --build
```

## 4. Verify serving

```bash
curl -s localhost/api/health    # expect {"status":"ok", ...}
```

## 5. Verify local -> remote sync

```bash
docker run --rm -v mdz_repo:/data alpine/sh -c \
  'echo "# Edited" > /data/repo/pages/Welcome.md'
sleep 5
git -C "$R/origin.git" log --oneline   # expect an "Auto-save ..." commit
```

## 6. Verify remote-wins

```bash
git -C "$R/seed" pull --ff-only origin main
printf '# From GitHub\n' > "$R/seed/pages/Welcome.md"
git -C "$R/seed" commit -am "remote edit"
git -C "$R/seed" push origin main
sleep 5
docker run --rm -v mdz_repo:/data alpine/cat /data/repo/pages/Welcome.md
# expect: "# From GitHub"  (remote won)
```

## 7. Tear down

```bash
docker compose down -v
docker volume rm mdz_repo
rm -rf "$R"
```
````

- [ ] **Step 2: Run the smoke test**

Follow `docs/smoke-test.md` end to end.
Expected: health OK; step 5 shows an `Auto-save` commit on origin; step 6 shows `# From GitHub` locally.

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-test.md
git commit -m "docs: phase-1 end-to-end smoke test"
```

---

## Self-review notes (author)

- **Spec coverage:** sync-sidecar behavior (§7.1) — outbound debounce-commit (Tasks 4,7), poll-pull (Tasks 5,7), remote-wins merge/reset (Task 5), exclusions (Task 4), bot identity (Task 4), deploy-key git auth (Task 10 env `GIT_SSH_COMMAND`). Compose + shared volume (§7.6) — Tasks 10–11. Caddy auto-TLS (§7.5) — Task 11. MDZ-has-no-Dockerfile gap — Task 9. Out of scope for this plan (later phases): magic-link/auth (Plan 2), spawn skill that clones the repo + seeds admin (Plan 3), agents (Plan 4). Phase 1 deliberately pre-clones the repo manually in the smoke test.
- **Placeholders:** none — every step has concrete file contents or commands.
- **Type consistency:** `SyncConfig` shape and the `git`/`isAncestor`/`commitLocal`/`pullRemote`/`pushIfAhead`/`syncOnce`/`createSyncer` signatures match between the interface block and all tasks.
- **Known follow-ups (not blockers):** `Dockerfile.mdz` `CMD` may need to be the direct `node packages/backend/dist/server.js` form depending on how `npm run start --workspace` resolves in the image (verified in Task 9 Step 2).
```
