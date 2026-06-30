# Control Plane — Part B (Agents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every served MDZ site a **general** agent (read-only over its pages) and the server **one** admin agent (read-write over all sites' content, able to administer users on any site) — running on one host nanoclaw, driven entirely through nanoclaw's supported surface, with the admin's per-site API tokens injected from the OneCLI vault (never on disk).

**Architecture:** Built on the **current upstream `nanocoai/nanoclaw`** (cloned at `~/work/nanoclaw`) — used **as-is, with zero nanoclaw code changes**; known upstream quirks are worked around in config. Agents are provisioned via the `ncl` CLI (`groups`/`messaging-groups`/`wirings`) plus direct `container_configs` JSON writes for the two fields `ncl` doesn't expose (`skills`, `additional_mounts`). Secrets reach the admin agent via the **OneCLI Agent Vault** (per-agent secret assignment, injected at request time through an HTTPS proxy). The only product code change is in **our own `mdz`**: a standalone `mint-admin-token` CLI that signs a short-lived `admins` session JWT. A host re-minter refreshes each site's token into the vault on a timer. Part A (serve) is already merged.

**Tech Stack:** nanoclaw (`ncl` CLI, container_configs DB, OneCLI gateway, launchd/systemd service, Docker agent containers); `mdz` backend (`jsonwebtoken`, vitest); bash + a little TypeScript glue in `mdz-ai-deploy/control/` (vitest); cron/systemd-timer.

## Global Constraints

- **No nanoclaw code edits.** Drive nanoclaw only through `ncl`, its setup scripts, OneCLI, and direct writes to its `container_configs` rows / the mount allowlist. Work around bugs in config, never by patching nanoclaw.
- **Mount-allowlist field name = `allowReadWrite`.** Upstream `/manage-mounts` writes `readOnly`, but the enforcing code reads `allowedRoots[].allowReadWrite`. Always write the allowlist JSON **directly** with `allowReadWrite` (a write mount silently degrades to read-only otherwise). The allowlist is cached for the nanoclaw process lifetime — write it **before** the service starts, or restart nanoclaw after changing it.
- **Additional mounts land at `/workspace/extra/<containerPath>`.** `containerPath` must be relative, no `..`, `/`, or `:`. RO is kernel-enforced (`:ro`).
- **Secrets never mounted.** Only `sites/<site>/repo` content is mounted to agents; `secrets/<site>/` (deploy keys, JWT_SECRET) is a sibling and is never in any agent mount. nanoclaw also blocks `.env`/`private_key`/`credentials`/`id_*` patterns as defense-in-depth.
- **Per-site admin token shape (must pass the mdz admin guard):** payload `{ email: "agent-admin@<site>.<base>", provider: "magic", groups: ["admins"] }`, **no `purpose` field**, signed with that site's `JWT_SECRET`, `expiresIn` default `45m`. Each site has its own `JWT_SECRET` (Part A `secrets/<site>/.env`), so tokens are per-site and minted inside that site's `mdz-<site>` container.
- **OneCLI host-pattern per site = `<site>.<base>`** (each site is a distinct host → clean per-site secret scoping). Secret name = `mdz-admin-<site>`, header `Authorization: Bearer {value}`. Assign each secret **only** to the admin agent (`onecli agents set-secrets`). Set `NANOCLAW_EGRESS_LOCKDOWN=true` for the admin agent so the token can't exit except via the gateway.
- **Agent instructions live in `groups/<folder>/CLAUDE.local.md`** (editable; `CLAUDE.md` is auto-composed at spawn — never hand-edit it).
- **`MDZ_REF` stays pinned to `819bb83`** for any mdz image reference (the mdz code change here advances `mdz` main; re-pin sites to the new SHA when rolling out B-1).
- **Site name = DNS label** (reuse `control/src/siteName.ts` from Part A). Agent folders: general = `<site>-general`, admin = `admin`.

## Phases

- **Phase B-1 — mdz short-lived admin token** (in `~/work/mdz`): the only product code change; TDD'd with vitest. Independently shippable.
- **Phase B-2 — host integration** (in `mdz-ai-deploy`, against `~/work/nanoclaw`): nanoclaw deploy wired into `/setup`, mount-allowlist + OneCLI bootstrap, the token re-minter, and the container-config provisioning helper.
- **Phase B-3 — `/add-agent` skill** (in `mdz-ai-deploy`): provisions a site's general agent and the one-time admin agent end-to-end.

> Integration reality: nanoclaw, OneCLI, Docker, and a real Telegram bot are **not** runnable in the authoring sandbox. As in Part A, pure logic is unit-tested (vitest) and integration scripts/skills are `bash -n`/config-validated here and **operator-verified on the server**. Each such step says so explicitly.

---

# Phase B-1 — mdz short-lived admin token (`~/work/mdz`)

All paths in this phase are under `/Users/romae/work/mdz`. The backend uses ESM + vitest; tests live in `packages/backend/tests/`.

## Task 1: Add `js-yaml` to the backend's production dependencies

The admin CLI imports `js-yaml` (via `storage/user-access.ts`) but `js-yaml` is absent from `packages/backend/package.json` — it resolves only by workspace hoist. After `npm prune --omit=dev` in the Docker image the CLI (both Part A's `seed-admin` and B-1's `mint-admin-token`) would crash. Fix the dependency.

**Files:**
- Modify: `packages/backend/package.json`

- [ ] **Step 1: Confirm the gap**

Run: `node -e "console.log(require('./packages/backend/package.json').dependencies['js-yaml'] ?? 'MISSING')"`
Expected: `MISSING`. Also confirm the import exists: `grep -rn "from \"js-yaml\"\|require('js-yaml')\|from 'js-yaml'" packages/backend/src` → shows `storage/user-access.ts`.

- [ ] **Step 2: Add the dependency**

In `packages/backend/package.json`, add to `dependencies` (keep alphabetical with the existing entries) the same `js-yaml` version the frontend already pins — read it first:
```bash
node -e "console.log(require('./packages/frontend/package.json').dependencies['js-yaml'])"
```
Add `"js-yaml": "<that exact version>"` to `packages/backend/package.json` `dependencies`, and `"@types/js-yaml": "<matching @types version from the repo, or ^4.0.9>"` to its `devDependencies`.

- [ ] **Step 3: Install + verify it resolves as a direct backend dep**

Run: `npm install` then `npm ls js-yaml --workspace @app/backend`
Expected: lists `js-yaml@<version>` as a direct dependency of `@app/backend` (not just hoisted).

- [ ] **Step 4: Commit**

```bash
git add packages/backend/package.json package-lock.json
git commit -m "fix(backend): declare js-yaml as a prod dep so the admin CLI survives prune"
```

## Task 2: `mintAdminToken` helper (TDD)

A standalone signer (no fastify) that mints a short-lived `admins` session token, mirroring `auth/magic-link.ts`'s `mintMagicToken`.

**Files:**
- Create: `packages/backend/src/auth/admin-token.ts`
- Test: `packages/backend/tests/auth/admin-token.test.ts`

**Interfaces:**
- Produces: `mintAdminToken(email: string, opts?: { expiresIn?: string | number }): string` and `getAdminTokenTtl(): string`.

- [ ] **Step 1: Write the failing test (`packages/backend/tests/auth/admin-token.test.ts`)**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { mintAdminToken, getAdminTokenTtl } from "../../src/auth/admin-token.js";

describe("mintAdminToken", () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, JWT_SECRET: "test-secret" }; });
  afterEach(() => { process.env = OLD; });

  it("mints a token that passes the admin guard's conditions", () => {
    const token = mintAdminToken("agent-admin@demo.example.com");
    const decoded = jwt.verify(token, "test-secret") as any;
    expect(decoded.groups).toContain("admins");
    expect(decoded.provider).toBe("magic");
    expect(decoded.email).toBe("agent-admin@demo.example.com");
    expect(decoded.purpose).toBeUndefined();      // must NOT be a magic-link token
    expect(typeof decoded.exp).toBe("number");    // expiry IS set
  });

  it("defaults to a 45m TTL and honors ADMIN_TOKEN_TTL", () => {
    expect(getAdminTokenTtl()).toBe("45m");
    process.env.ADMIN_TOKEN_TTL = "10m";
    expect(getAdminTokenTtl()).toBe("10m");
  });

  it("rejects after expiry", () => {
    const token = mintAdminToken("agent-admin@demo.example.com", { expiresIn: -1 });
    expect(() => jwt.verify(token, "test-secret")).toThrow(/expired/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace @app/backend -- admin-token`
Expected: FAIL — cannot resolve `../../src/auth/admin-token.js`.

- [ ] **Step 3: Implement `packages/backend/src/auth/admin-token.ts`**

```ts
import jwt from "jsonwebtoken";

// Mirrors auth/magic-link.ts's secret read so the CLI can sign standalone (no fastify).
function getSecret(): string {
  return process.env.JWT_SECRET || "dev-secret-change-in-production";
}

const DEFAULT_TTL = "45m";

export function getAdminTokenTtl(): string {
  return process.env.ADMIN_TOKEN_TTL || DEFAULT_TTL;
}

/**
 * Mint a short-lived `admins` SESSION token (not a magic-link). It carries
 * groups:["admins"] and NO `purpose`, so it passes the /api/admin/* guard.
 */
export function mintAdminToken(
  email: string,
  opts?: { expiresIn?: string | number }
): string {
  const payload = { email, provider: "magic", groups: ["admins"] };
  return jwt.sign(payload, getSecret(), {
    expiresIn: opts?.expiresIn ?? getAdminTokenTtl(),
  } as jwt.SignOptions);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --workspace @app/backend -- admin-token`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/auth/admin-token.ts packages/backend/tests/auth/admin-token.test.ts
git commit -m "feat(auth): mintAdminToken — standalone short-lived admins session token"
```

## Task 3: `mint-admin-token` CLI command (TDD)

**Files:**
- Modify: `packages/backend/src/cli/admin.ts`
- Test: `packages/backend/tests/cli/admin-cli.test.ts` (append; if absent, create)

**Interfaces:**
- Consumes: `mintAdminToken` (Task 2).
- Produces: `runAdminCommand(["mint-admin-token", "<email>"])` resolves to a raw JWT string.

- [ ] **Step 1: Add the failing test (append to `packages/backend/tests/cli/admin-cli.test.ts`)**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { runAdminCommand } from "../../src/cli/admin.js";

describe("admin cli: mint-admin-token", () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, JWT_SECRET: "test-secret" }; });
  afterEach(() => { process.env = OLD; });

  it("prints a verifiable admins token", async () => {
    const out = await runAdminCommand(["mint-admin-token", "agent-admin@demo.example.com"]);
    const decoded = jwt.verify(out.trim(), "test-secret") as any;
    expect(decoded.groups).toContain("admins");
    expect(decoded.purpose).toBeUndefined();
  });

  it("requires an email", async () => {
    await expect(runAdminCommand(["mint-admin-token"])).rejects.toThrow(/usage: mint-admin-token/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace @app/backend -- admin-cli`
Expected: FAIL — `Unknown command: mint-admin-token`.

- [ ] **Step 3: Implement — add the `case` and import**

In `packages/backend/src/cli/admin.ts`, add the import near the existing auth imports:
```ts
import { mintAdminToken } from "../auth/admin-token.js";
```
Add this `case` inside the `switch (command)` block (next to `mint-link`):
```ts
    case "mint-admin-token": {
      const [email] = rest;
      if (!email) throw new Error("usage: mint-admin-token <email>");
      return mintAdminToken(email);
    }
```
Update the `default:` help string to include `mint-admin-token`:
```ts
        "commands: add-user, set-groups, remove, mint-link, mint-admin-token, list"
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --workspace @app/backend -- admin-cli`
Expected: PASS.

- [ ] **Step 5: Full backend suite green**

Run: `npm test --workspace @app/backend`
Expected: all backend tests pass (existing + the new admin-token + cli tests).

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/cli/admin.ts packages/backend/tests/cli/admin-cli.test.ts
git commit -m "feat(cli): mint-admin-token subcommand for the host re-minter"
```

## Task 4: Document the env knob

**Files:**
- Modify: the mdz backend env example/doc where `MAGIC_LINK_TTL` is documented (find it: `grep -rn "MAGIC_LINK_TTL" --include=*.md --include=*.example .`).

- [ ] **Step 1: Add `ADMIN_TOKEN_TTL`**

Wherever `MAGIC_LINK_TTL` is documented, add a sibling line:
```
ADMIN_TOKEN_TTL=45m   # TTL of agent admin session tokens minted by `mint-admin-token` (re-minter refreshes before expiry)
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs(backend): document ADMIN_TOKEN_TTL"
```

> **Phase B-1 ships independently.** Roll out by rebuilding the mdz image at the new `mdz` main SHA and re-pinning sites' `MDZ_REF` (Part A `render-site-env`). Verify on the server: `docker run --rm mdz-app:<new-sha> node packages/backend/dist/cli/admin.js list` runs (this is also the Part A js-yaml first-run check), and `... mint-admin-token agent-admin@demo.example.com` prints a JWT.

---

# Phase B-2 — Host integration (`mdz-ai-deploy` + `~/work/nanoclaw`)

All paths under `/Users/romae/work/mdz-ai-deploy` unless noted. Reuses Part A's `control/` (vitest) + `scripts/lib/common.sh` conventions. Pure logic → vitest; docker/nanoclaw/OneCLI/cron scripts → `bash -n` + server-verify.

## Task 5: Pure helpers — allowlist merge + agent/secret naming (TDD)

**Files:**
- Create: `control/src/agents.ts`
- Test: `control/tests/agents.test.ts`

**Interfaces:**
- Produces:
  - `agentFolder(site: string, role: "general" | "admin"): string` — `admin` → `"admin"`; otherwise `"<site>-general"` (validates the site name).
  - `adminSecretName(site: string): string` → `"mdz-admin-<site>"`.
  - `siteApiHost(site: string, baseDomain: string): string` → `"<site>.<baseDomain>"`.
  - `mergeAllowlistRoot(json: string | null, root: { path: string; allowReadWrite: boolean; description?: string }): string` — returns pretty JSON for `~/.config/nanoclaw/mount-allowlist.json` with `root` present (by `path`) and `allowReadWrite` set using the field name the enforcing code reads. Preserves other roots + `blockedPatterns`; idempotent (updates in place if the path already exists).

- [ ] **Step 1: Write the failing test (`control/tests/agents.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { agentFolder, adminSecretName, siteApiHost, mergeAllowlistRoot } from "../src/agents.js";

describe("naming helpers", () => {
  it("agentFolder", () => {
    expect(agentFolder("demo", "general")).toBe("demo-general");
    expect(agentFolder("demo", "admin")).toBe("admin");
    expect(() => agentFolder("Bad", "general")).toThrow();
  });
  it("adminSecretName / siteApiHost", () => {
    expect(adminSecretName("demo")).toBe("mdz-admin-demo");
    expect(siteApiHost("demo", "example.com")).toBe("demo.example.com");
  });
});

describe("mergeAllowlistRoot", () => {
  it("creates the allowlist when none exists, using allowReadWrite", () => {
    const out = mergeAllowlistRoot(null, { path: "/srv/sites", allowReadWrite: true, description: "mdz content" });
    const j = JSON.parse(out);
    expect(j.allowedRoots).toEqual([{ path: "/srv/sites", allowReadWrite: true, description: "mdz content" }]);
    expect(Array.isArray(j.blockedPatterns)).toBe(true);
  });
  it("updates an existing root in place (idempotent) and preserves siblings", () => {
    const existing = JSON.stringify({
      allowedRoots: [{ path: "/other", allowReadWrite: false }, { path: "/srv/sites", allowReadWrite: false }],
      blockedPatterns: ["custom"],
    });
    const out = mergeAllowlistRoot(existing, { path: "/srv/sites", allowReadWrite: true });
    const j = JSON.parse(out);
    expect(j.allowedRoots).toContainEqual({ path: "/other", allowReadWrite: false });
    expect(j.allowedRoots.find((r: any) => r.path === "/srv/sites").allowReadWrite).toBe(true);
    expect(j.allowedRoots.filter((r: any) => r.path === "/srv/sites")).toHaveLength(1);
    expect(j.blockedPatterns).toContain("custom");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run control/tests/agents.test.ts`
Expected: FAIL — cannot resolve `../src/agents.js`.

- [ ] **Step 3: Implement `control/src/agents.ts`**

```ts
import { validateSiteName } from "./siteName.js";

export function agentFolder(site: string, role: "general" | "admin"): string {
  if (role === "admin") return "admin";
  return `${validateSiteName(site)}-general`;
}

export function adminSecretName(site: string): string {
  return `mdz-admin-${validateSiteName(site)}`;
}

export function siteApiHost(site: string, baseDomain: string): string {
  return `${validateSiteName(site)}.${baseDomain}`;
}

interface AllowedRoot { path: string; allowReadWrite: boolean; description?: string }
interface Allowlist { allowedRoots: AllowedRoot[]; blockedPatterns: string[] }

export function mergeAllowlistRoot(
  json: string | null,
  root: AllowedRoot
): string {
  const base: Allowlist = json
    ? (JSON.parse(json) as Allowlist)
    : { allowedRoots: [], blockedPatterns: [] };
  base.allowedRoots = base.allowedRoots ?? [];
  base.blockedPatterns = base.blockedPatterns ?? [];
  const idx = base.allowedRoots.findIndex((r) => r.path === root.path);
  if (idx >= 0) base.allowedRoots[idx] = { ...base.allowedRoots[idx], ...root };
  else base.allowedRoots.push(root);
  return JSON.stringify(base, null, 2) + "\n";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run control/tests/agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the control CLI to expose these**

In `control/src/cli.ts`, add cases (consumed by the bash scripts below):
```ts
    case "agent-folder":
      process.stdout.write(agentFolder(req("site"), req("role") as "general" | "admin") + "\n");
      break;
    case "admin-secret-name":
      process.stdout.write(adminSecretName(req("site")) + "\n");
      break;
    case "site-api-host":
      process.stdout.write(siteApiHost(req("site"), req("base")) + "\n");
      break;
    case "merge-allowlist-root": {
      const file = req("file");
      const cur = existsSync(file) ? readFileSync(file, "utf8") : null;
      process.stdout.write(
        mergeAllowlistRoot(cur, { path: req("path"), allowReadWrite: arg("rw") === "true", description: arg("desc") })
      );
      break;
    }
```
Add two static imports at the top of `control/src/cli.ts` (no async refactor needed):
```ts
import { existsSync, readFileSync } from "node:fs";
import { agentFolder, adminSecretName, siteApiHost, mergeAllowlistRoot } from "./agents.js";
```

- [ ] **Step 6: Add a CLI test (append to `control/tests/cli.test.ts`)**

```ts
it("agent-folder / admin-secret-name / site-api-host", async () => {
  expect((await RUN(["agent-folder", "--site=demo", "--role=general"])).stdout).toBe("demo-general");
  expect((await RUN(["admin-secret-name", "--site=demo"])).stdout).toBe("mdz-admin-demo");
  expect((await RUN(["site-api-host", "--site=demo", "--base=example.com"])).stdout).toBe("demo.example.com");
});
```

- [ ] **Step 7: Full suite green**

Run: `npm test`
Expected: PASS (Part A tests + new agents + cli cases).

- [ ] **Step 8: Commit**

```bash
git add control/src/agents.ts control/tests/agents.test.ts control/src/cli.ts control/tests/cli.test.ts
git commit -m "feat(control): agent/secret naming + mount-allowlist merge helper (TDD)"
```

## Task 6: Container-config provisioning helper (the `ncl` gap)

`ncl` has no command to set a group's `skills` or `additional_mounts`; nanoclaw exposes `updateContainerConfigJson(agentGroupId, field, value)` in `src/db/container-configs.ts`. This helper calls that API from within the nanoclaw checkout.

**Files:**
- Create: `scripts/nc/set-container-json.mjs` (run with nanoclaw's node, from the nanoclaw dir)
- Create: `scripts/nc-set-container-json.sh` (wrapper that locates the nanoclaw checkout and invokes the `.mjs`)

- [ ] **Step 1: Verify the nanoclaw API contract (integration; do once on the server/checkout)**

Run (in the nanoclaw checkout): `grep -n "export function updateContainerConfigJson\|export const updateContainerConfigJson" src/db/container-configs.ts`
Expected: an export `updateContainerConfigJson(agentGroupId: string, field: 'skills' | 'additional_mounts' | ..., value: unknown)`. **If the name/signature differs, stop and adjust this task** — the rest of the helper depends on it. Confirm the compiled path (`dist/db/container-configs.js`).

- [ ] **Step 2: Implement `scripts/nc/set-container-json.mjs`**

```js
// Usage: NC_DIR=<nanoclaw checkout> node set-container-json.mjs <agentGroupId> <field> <json-value>
// Run with the nanoclaw checkout's build present (pnpm build). Imports nanoclaw's own DB API.
import { pathToFileURL } from "node:url";
import path from "node:path";

const [, , agentGroupId, field, jsonValue] = process.argv;
if (!agentGroupId || !field || jsonValue === undefined) {
  console.error("usage: set-container-json.mjs <agentGroupId> <field> <json-value>");
  process.exit(1);
}
const ncDir = process.env.NC_DIR;
if (!ncDir) { console.error("NC_DIR (nanoclaw checkout) is required"); process.exit(1); }

const mod = await import(pathToFileURL(path.join(ncDir, "dist/db/container-configs.js")).href);
mod.updateContainerConfigJson(agentGroupId, field, JSON.parse(jsonValue));
console.error(`set ${field} for ${agentGroupId}`);
```

- [ ] **Step 3: Implement `scripts/nc-set-container-json.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: NC_DIR=<nanoclaw checkout> nc-set-container-json.sh <agentGroupId> <field> <json-value>
: "${NC_DIR:?NC_DIR (nanoclaw checkout path) is required}"
[ -f "$NC_DIR/dist/db/container-configs.js" ] || die "nanoclaw not built at $NC_DIR (run pnpm build there)"
NC_DIR="$NC_DIR" node "$REPO_ROOT/scripts/nc/set-container-json.mjs" "$@"
```

- [ ] **Step 4: Syntax check + chmod**

Run: `chmod +x scripts/nc-set-container-json.sh && bash -n scripts/nc-set-container-json.sh && node --check scripts/nc/set-container-json.mjs && echo ok`
Expected: `ok`. (Full behavior is server-verified once nanoclaw is built — Step 1's contract check gates it.)

- [ ] **Step 5: Commit**

```bash
git add scripts/nc-set-container-json.sh scripts/nc/set-container-json.mjs
git commit -m "feat(control): helper to set container_configs skills/additional_mounts via nanoclaw API"
```

## Task 7: nanoclaw deploy + mount-allowlist bootstrap (integration scripts)

**Files (Create; `chmod +x`; `bash -n`-checked; server-verified):**
- `scripts/deploy-nanoclaw.sh`, `scripts/ensure-mount-allowlist.sh`

- [ ] **Step 1: `scripts/deploy-nanoclaw.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd git docker node
# usage: NC_DIR=~/work/nanoclaw TELEGRAM_BOT_TOKEN=... deploy-nanoclaw.sh
: "${NC_DIR:?NC_DIR (nanoclaw checkout path) is required}"
[ -d "$NC_DIR/.git" ] || die "no nanoclaw checkout at $NC_DIR (clone nanocoai/nanoclaw there first)"
log "Deploying nanoclaw from $NC_DIR"
# 1. Install + build (nanoclaw uses pnpm)
( cd "$NC_DIR" && command -v pnpm >/dev/null || die "pnpm required"; pnpm install && pnpm build )
# 2. Build the agent container image
( cd "$NC_DIR/container" && bash build.sh )
# 3. Run nanoclaw's own setup (installs the launchd/systemd service, OneCLI init, etc.)
log "Run nanoclaw's setup interactively (its /setup or setup.sh) to install the service + OneCLI + Anthropic creds:"
log "  cd $NC_DIR && bash setup.sh    # then /init-onecli, and add-telegram with TELEGRAM_BOT_TOKEN"
# 4. Telegram adapter (idempotent; needs the token in env)
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -f "$NC_DIR/setup/add-telegram.sh" ]; then
  ( cd "$NC_DIR" && TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" bash setup/add-telegram.sh ) || warn "add-telegram failed; run it manually"
fi
log "nanoclaw deploy steps issued. Verify the service is running before provisioning agents."
```

> This script **orchestrates** nanoclaw's own supported setup rather than reimplementing it. The interactive parts (service install, OneCLI init, Anthropic cred in the vault) are nanoclaw's `setup.sh` / `/init-onecli`; the skill (Task 9) walks the operator through them.

- [ ] **Step 2: `scripts/ensure-mount-allowlist.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: ensure-mount-allowlist.sh   (adds the sites/ root with allowReadWrite=true)
allowlist="$HOME/.config/nanoclaw/mount-allowlist.json"
sites_root="$REPO_ROOT/sites"
mkdir -p "$(dirname "$allowlist")"
updated="$(ctl merge-allowlist-root --file="$allowlist" --path="$sites_root" --rw=true --desc="mdz site content")"
printf '%s' "$updated" > "$allowlist"
log "mount allowlist now grants RW on $sites_root (field: allowReadWrite). Restart nanoclaw to pick it up (allowlist is cached for process lifetime)."
```

> Writes `allowReadWrite` (not `readOnly`) directly — the documented workaround. The general agent still gets RO because its own `additional_mounts` entry sets `readonly: true`; `allowReadWrite:true` only *permits* RW, the admin agent opts in.

- [ ] **Step 3: chmod + syntax check**

Run: `chmod +x scripts/deploy-nanoclaw.sh scripts/ensure-mount-allowlist.sh && for s in scripts/deploy-nanoclaw.sh scripts/ensure-mount-allowlist.sh; do bash -n "$s" && echo "ok: $s"; done`
Expected: `ok:` for both.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-nanoclaw.sh scripts/ensure-mount-allowlist.sh
git commit -m "feat(control): nanoclaw deploy + mount-allowlist bootstrap scripts"
```

## Task 8: Per-site admin token re-minter (integration scripts)

Mints a fresh `admins` token inside each site's `mdz-<site>` container and pushes it into the OneCLI vault, assigned only to the admin agent. Installed on a timer (tokens are 45m; refresh every ~30m).

**Files (Create; `chmod +x`; `bash -n`-checked; server-verified):**
- `scripts/mint-site-admin-secret.sh`, `scripts/reminter.sh`, `scripts/install-reminter.sh`

- [ ] **Step 1: `scripts/mint-site-admin-secret.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker node onecli
# usage: mint-site-admin-secret.sh <site>   (mints + upserts the per-site admin token in OneCLI)
site="${1:?site}"
ctl site-name --site="$site" >/dev/null
env="$REPO_ROOT/secrets/$site/.env"; [ -f "$env" ] || die "missing $env"
base="$(grep -E '^BASE_DOMAIN=' "$env" | cut -d= -f2-)"; [ -n "$base" ] || die "no BASE_DOMAIN in $env"
host="$(ctl site-api-host --site="$site" --base="$base")"
secret_name="$(ctl admin-secret-name --site="$site")"
# Mint a fresh token inside the site's mdz container (it holds this site's JWT_SECRET)
token="$(docker compose -p "mdz-$site" exec -T mdz node packages/backend/dist/cli/admin.js mint-admin-token "agent-admin@$host")"
[ -n "$token" ] || die "mint-admin-token produced no token for $site"
# Upsert into OneCLI: create if absent, else update the value
if onecli secrets list 2>/dev/null | grep -q "$secret_name"; then
  onecli secrets update --name "$secret_name" --value "$token"
else
  onecli secrets create --name "$secret_name" --type generic --value "$token" \
    --host-pattern "$host" --header-name "Authorization" --value-format "Bearer {value}"
fi
log "refreshed OneCLI secret $secret_name for https://$host"
```

> Exact `onecli` flags must be confirmed against the installed OneCLI version on first run (the `secrets list`/`create`/`update` shapes were taken from the nanoclaw skill docs). Assigning the secret to the admin agent is done once at admin provisioning (Task in B-3), not here.

- [ ] **Step 2: `scripts/reminter.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
# Refresh every site's admin token. Run on a timer.
shopt -s nullglob
for d in "$REPO_ROOT"/sites/*/; do
  site="$(basename "$d")"
  "$REPO_ROOT/scripts/mint-site-admin-secret.sh" "$site" || warn "re-mint failed for $site"
done
```

- [ ] **Step 3: `scripts/install-reminter.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
# Install a ~30-minute timer for reminter.sh. macOS=launchd, Linux=cron fallback.
if [ "$(uname)" = "Darwin" ]; then
  plist="$HOME/Library/LaunchAgents/com.mdz.reminter.plist"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mdz.reminter</string>
  <key>ProgramArguments</key><array><string>$REPO_ROOT/scripts/reminter.sh</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  log "installed launchd re-minter (every 30m): $plist"
else
  line="*/30 * * * * $REPO_ROOT/scripts/reminter.sh >> $REPO_ROOT/.reminter.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'scripts/reminter.sh'; echo "$line" ) | crontab -
  log "installed cron re-minter (every 30m)"
fi
```

- [ ] **Step 4: chmod + syntax check**

Run: `chmod +x scripts/mint-site-admin-secret.sh scripts/reminter.sh scripts/install-reminter.sh && for s in scripts/mint-site-admin-secret.sh scripts/reminter.sh scripts/install-reminter.sh; do bash -n "$s" && echo "ok: $s"; done`
Expected: `ok:` for all three.

- [ ] **Step 5: Commit**

```bash
git add scripts/mint-site-admin-secret.sh scripts/reminter.sh scripts/install-reminter.sh
git commit -m "feat(control): per-site admin-token re-minter into the OneCLI vault"
```

---

# Phase B-3 — `/add-agent` skill (`mdz-ai-deploy`)

## Task 9: agent registration script (integration)

A single script that drives `ncl` + the provisioning helper + (for admin) OneCLI, for both roles. Server-verified.

**Files:**
- Create: `scripts/register-agent.sh` (`chmod +x`, `bash -n`)

- [ ] **Step 1: Implement `scripts/register-agent.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node ncl
# usage: NC_DIR=~/work/nanoclaw register-agent.sh general <site> <base> | register-agent.sh admin <base>
: "${NC_DIR:?NC_DIR required}"
role="${1:?role (general|admin)}"
abs_sites="$REPO_ROOT/sites"

create_group() { # <name> <folder> -> prints group id
  ncl groups create --name "$1" --folder "$2" | node -e 'process.stdin.resume();let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id)}catch{console.log(s.trim())}})'
}

if [ "$role" = "general" ]; then
  site="${2:?site}"; base="${3:?base}"
  ctl site-name --site="$site" >/dev/null
  folder="$(ctl agent-folder --site="$site" --role=general)"
  [ -d "$abs_sites/$site/repo/pages" ] || die "missing $abs_sites/$site/repo/pages"
  gid="$(create_group "$site general" "$folder")"
  ncl groups config update --id "$gid" --provider claude --assistant-name "$site"
  # skills minimal + RO pages mount (no ncl command for these -> helper)
  NC_DIR="$NC_DIR" "$REPO_ROOT/scripts/nc-set-container-json.sh" "$gid" skills '["welcome"]'
  NC_DIR="$NC_DIR" "$REPO_ROOT/scripts/nc-set-container-json.sh" "$gid" additional_mounts \
    "$(printf '[{"hostPath":"%s/%s/repo/pages","containerPath":"pages","readonly":true}]' "$abs_sites" "$site")"
  # operator-editable instructions (thin pointer to the synced file inside the RO mount)
  mkdir -p "$NC_DIR/groups/$folder"
  printf 'Treat /workspace/extra/pages/.mdz/general.md as your operator instructions. You are READ-ONLY over this site'"'"'s pages.\n' \
    > "$NC_DIR/groups/$folder/CLAUDE.local.md"
  mkdir -p "$abs_sites/$site/repo/pages/.mdz"
  [ -f "$abs_sites/$site/repo/pages/.mdz/general.md" ] || printf '# %s general agent\n\nRead-only helper over this site.\n' "$site" > "$abs_sites/$site/repo/pages/.mdz/general.md"
  ncl groups restart --id "$gid"
  log "general agent $folder registered (group $gid). Bind a chat with: ncl messaging-groups create + ncl wirings create."
  printf '%s\n' "$gid"

elif [ "$role" = "admin" ]; then
  base="${2:?base}"
  gid="$(create_group "admin" "admin")"
  ncl groups config update --id "$gid" --provider claude --assistant-name "admin"
  NC_DIR="$NC_DIR" "$REPO_ROOT/scripts/nc-set-container-json.sh" "$gid" additional_mounts \
    "$(printf '[{"hostPath":"%s","containerPath":"sites","readonly":false}]' "$abs_sites")"
  mkdir -p "$NC_DIR/groups/admin"
  cat > "$NC_DIR/groups/admin/CLAUDE.local.md" <<'MD'
You administer all MDZ sites. Content for every site is at /workspace/extra/sites/<site>/repo (READ-WRITE).
To manage users on a site, call its admin API at https://<site>.<base>/api/admin/* — the gateway injects that
site's admin token automatically (you never see the raw token). To change a site's general-agent instructions,
edit /workspace/extra/sites/<site>/repo/pages/.mdz/general.md. You can never see deploy keys or JWT secrets.
MD
  # Assign every existing site's admin secret to THIS agent only (OneCLI agent identity = group id-derived).
  log "Now: for each site run scripts/mint-site-admin-secret.sh <site>, then 'onecli agents set-secrets' to assign mdz-admin-<site> to this admin agent ONLY; set NANOCLAW_EGRESS_LOCKDOWN=true."
  ncl groups restart --id "$gid"
  log "admin agent registered (group $gid)."
  printf '%s\n' "$gid"
else
  die "unknown role: $role (general|admin)"
fi
```

> The OneCLI per-agent secret assignment (`onecli agents set-secrets --id <agentId> --secret-ids ...`) and `ensureAgent` identity mapping are confirmed on the server during provisioning (the agent identifier nanoclaw registers is the agent-group id). The skill (Task 10) makes this explicit and verifies it.

- [ ] **Step 2: chmod + syntax check**

Run: `chmod +x scripts/register-agent.sh && bash -n scripts/register-agent.sh && echo ok`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/register-agent.sh
git commit -m "feat(control): register-agent.sh — provision general/admin agents via ncl + helper"
```

## Task 10: `/add-agent` SKILL.md

**Files:**
- Create: `.claude/skills/add-agent/SKILL.md`

- [ ] **Step 1: Write `.claude/skills/add-agent/SKILL.md`**

````markdown
---
name: add-agent
description: Provision an MDZ agent on the host nanoclaw — a per-site read-only "general" agent, or the one-time server-wide read-write "admin" agent. Requires /setup (incl. nanoclaw deploy) to have run.
---

# /add-agent — provision a site general agent or the one admin agent

Run from the `mdz-ai-deploy` repo root on a server where `/setup` deployed nanoclaw. Set `NC_DIR` to the nanoclaw checkout (default `~/work/nanoclaw`).

## 1. Preflight
- nanoclaw service running; OneCLI gateway up; agent image built.
- `scripts/ensure-mount-allowlist.sh` has been run (grants RW on `sites/` via `allowReadWrite`) and nanoclaw was restarted after (the allowlist is cached for the process lifetime).
- For a general agent: `sites/<site>/repo/pages` exists (the site was added via `/add-mdz-site`).

## 2. Inputs (AskUserQuestion)
- **Role**: `general` (per site) or `admin` (one-time, server-wide).
- For `general`: **site name** (DNS label) and **base domain**.
- **Telegram chat id** for this agent's dedicated chat.

## 3a. General agent
```bash
NC_DIR=~/work/nanoclaw scripts/register-agent.sh general <site> <base>   # prints the group id
```
Creates the group, sets a minimal skill set + a **read-only** `pages/` mount at `/workspace/extra/pages`, writes `groups/<site>-general/CLAUDE.local.md` (a thin pointer to the synced `pages/.mdz/general.md`), seeds that file, and restarts. No secrets are assigned — the general agent holds none.

## 3b. Admin agent (one-time)
```bash
NC_DIR=~/work/nanoclaw scripts/register-agent.sh admin <base>           # prints the group id
```
Creates the `admin` group with a **read-write** mount of all `sites/` content (no secrets — `secrets/` is a sibling, never mounted), writes its instructions, and restarts. Then wire per-site tokens:
```bash
# For each existing site: mint its token into the vault, then assign it to ONLY this admin agent.
for d in sites/*/; do scripts/mint-site-admin-secret.sh "$(basename "$d")"; done
# Assign every mdz-admin-<site> secret to this admin agent's OneCLI identity (its agent-group id):
#   onecli agents set-secrets --id <adminAgentId> --secret-ids <comma-list of mdz-admin-* secret ids>
# And enable egress lockdown for the admin so the token can't bypass the gateway:
#   set NANOCLAW_EGRESS_LOCKDOWN=true for the admin agent's container env
scripts/install-reminter.sh   # keep the per-site tokens fresh (every 30m)
```

## 4. Bind the chat (both roles)
```bash
ncl messaging-groups create --channel-type telegram --platform-id <chat-id> --name "<agent> chat" --unknown-sender-policy request_approval
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <group-id> --engage-mode pattern --engage-pattern "." --session-mode shared
```
(Add the bot to the chat and turn Group Privacy off via nanoclaw's `add-telegram` flow if not already done.)

## 5. Verify
- General: message its chat; confirm it can read a page but a prompt to read `JWT_SECRET` / write a page / call `/api/admin/*` fails (RO mount, no secret, container isolation).
- Admin: message its chat; "add alice@x to writers on <site>" succeeds via that site's admin API (token injected by the gateway); confirm it cannot see `secrets/`.

> **Adding a site later** (`/add-mdz-site` step 8 hook): provision the new site's general agent (`/add-agent general`), then `scripts/mint-site-admin-secret.sh <new-site>` + assign that one secret to the existing admin agent. The admin's `sites/` mount already covers the new content — no re-mount.
````

- [ ] **Step 2: Validate frontmatter + script references**

Run:
```bash
head -4 .claude/skills/add-agent/SKILL.md
grep -oE 'scripts/[a-z./-]+\.sh' .claude/skills/add-agent/SKILL.md | sort -u | while read -r s; do test -f "$s" && echo "ref ok: $s" || echo "MISSING: $s"; done
```
Expected: frontmatter shows `name: add-agent`; every referenced script prints `ref ok`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-agent/SKILL.md
git commit -m "feat(skill): /add-agent provisions general + admin agents on nanoclaw"
```

## Task 11: Wire the Part A hooks + docs

**Files:**
- Modify: `.claude/skills/setup/SKILL.md` (replace the Part B deferred note with the real nanoclaw-deploy step)
- Modify: `.claude/skills/add-mdz-site/SKILL.md` (replace its Part B deferred note with the general-agent provisioning hook)
- Create: `docs/control-plane-agents.md`
- Modify: `docs/superpowers/plans/2026-06-29-control-plane-and-agents.md` (mark Part B build-order items done)

- [ ] **Step 1: `/setup` — real nanoclaw step**

In `.claude/skills/setup/SKILL.md`, replace the `> Part B (deferred)` block with a step 7:
```markdown
## 7. Deploy the host nanoclaw (agents)
Collect the Telegram bot token + Claude auth (step 2). Then:
`NC_DIR=~/work/nanoclaw TELEGRAM_BOT_TOKEN=<token> scripts/deploy-nanoclaw.sh`
Follow nanoclaw's own setup (service install, `/init-onecli`, add-telegram). Then grant agents access to content:
`scripts/ensure-mount-allowlist.sh` and restart nanoclaw. Provision agents with `/add-agent`.
```

- [ ] **Step 2: `/add-mdz-site` — step 8 hook**

In `.claude/skills/add-mdz-site/SKILL.md`, replace its `> Part B (deferred)` block with:
```markdown
## 8. Provision agents (Part B)
Give the new site a general agent and extend the admin agent:
`NC_DIR=~/work/nanoclaw scripts/register-agent.sh general <site> <base>` (then bind a chat),
and `scripts/mint-site-admin-secret.sh <site>` + assign `mdz-admin-<site>` to the existing admin agent. See `/add-agent`.
```

- [ ] **Step 3: Create `docs/control-plane-agents.md`**

```markdown
# Control plane — agents (Part B)

Every site gets a read-only **general** agent over its pages; the server has **one** read-write **admin** agent over all sites' content. One host nanoclaw (`nanocoai/nanoclaw`, used as-is) runs them all.

## Model
- General agent (per site): container, RO mount of `sites/<site>/repo/pages` → `/workspace/extra/pages`, no secrets, own chat. Instructions: `sites/<site>/repo/pages/.mdz/general.md` (synced).
- Admin agent (one): container, RW mount of `sites/` → `/workspace/extra/sites` (content only — `secrets/` never mounted). Calls each site's `/api/admin/*` using a short-lived per-site `admins` token injected by the **OneCLI vault** (`mdz-admin-<site>`, host `<site>.<base>`). Egress lockdown on.

## Pieces
- `mdz`: `mint-admin-token` CLI mints a 45m `admins` session JWT (signed with that site's JWT_SECRET).
- Re-minter (`scripts/reminter.sh`, every 30m): refreshes each site's vault secret.
- Provisioning: `/add-agent` → `ncl groups/messaging-groups/wirings` + `scripts/nc-set-container-json.sh` for `skills`/`additional_mounts`.

## Workarounds (nanoclaw used as-is)
- Mount allowlist is written directly with `allowReadWrite` (upstream `/manage-mounts` writes the wrong field name).
- General-agent tool-narrowing (drop Bash/WebFetch) would need an upstream change → not done; the boundary is container + RO + no-secrets.

## Tradeoff
One admin agent has RW on all sites + can administer every site → if prompt-injected, blast radius is the whole server. Accepted for operational simplicity; mitigated by container isolation, short-lived per-site tokens (no raw secrets), secrets kept out of all mounts, and egress lockdown.
```

- [ ] **Step 4: Mark Part B done in the combined plan**

In `docs/superpowers/plans/2026-06-29-control-plane-and-agents.md` `## Build order`, append ` **DONE** (see docs/superpowers/plans/2026-06-30-control-plane-part-b-agents.md; built against current nanocoai/nanoclaw — the old fork's code-change items were obsolete)` to items 2–5.

- [ ] **Step 5: Validate + commit**

Run: `npm test` (Part A + control suite still green) and the skill ref-checks from Tasks 9–10.
```bash
git add .claude/skills/setup/SKILL.md .claude/skills/add-mdz-site/SKILL.md docs/control-plane-agents.md docs/superpowers/plans/2026-06-29-control-plane-and-agents.md
git commit -m "docs(control): wire agent hooks into /setup + /add-mdz-site; Part B overview"
```

---

## Self-review notes (author)

- **Spec coverage (combined plan Part B):** B1 nanoclaw deploy → Task 7 + skill step (uses nanoclaw's own setup; the "generalize hardcoded ZB/IIKO bits" item is **obsolete** — upstream is generic). B2 general agent → Task 9 (`general`) + Task 10. B3 admin agent → Task 9 (`admin`) + OneCLI assignment + re-minter (Tasks 8, 10). B4 registration → `ncl` + Task 6 helper (the `register_group` IPC mechanism is replaced by `ncl`/DB). B5 `/add-agent` → Tasks 9–10. B6 code changes → **mdz only** (Phase B-1); the nanoclaw `allowedTools`/generalization items are **dropped** (per-group tool gating needs an upstream change we're not making; generalization is unnecessary upstream). B7 threat model → `docs/control-plane-agents.md` + the egress-lockdown / no-secrets / RO constraints.
- **Deliberate divergences from the combined plan (substrate changed):** driven via `ncl` + OneCLI vault (not `register_group` IPC + on-disk token files); zero nanoclaw code edits (per user); admin token vault-injected (not file-mounted); general-agent tool-narrowing deferred (needs upstream change).
- **Integration-verification points (not unit-testable here; gate on first server run):** (1) `updateContainerConfigJson` export name/signature in nanoclaw `src/db/container-configs.ts` (Task 6 Step 1); (2) exact `onecli secrets/agents` flag shapes vs the installed OneCLI; (3) the agent-group→OneCLI identity mapping nanoclaw uses for `set-secrets`; (4) the mdz image runs the CLI after prune (Phase B-1 js-yaml fix + the Part A first-run check). Each is called out at its task.
- **Type/flag consistency:** `control` cli subcommands added in Task 5 (`agent-folder`, `admin-secret-name`, `site-api-host`, `merge-allowlist-root`) match their uses in Tasks 7–9; `mintAdminToken` signature matches between B-1 Tasks 2 and 3; agent folders (`<site>-general`, `admin`) and secret names (`mdz-admin-<site>`) are consistent across B-2/B-3.
- **Known follow-ups:** OneCLI host-pattern matches by host only (fine — each site is a distinct host); short-lived tokens require the re-minter timer (no native nanoclaw refresh); a per-agent secret-injection-via-stdin would be cleaner than vault-update but the vault path is sufficient.
```
