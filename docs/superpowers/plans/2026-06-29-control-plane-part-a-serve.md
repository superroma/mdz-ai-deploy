# Control Plane — Part A (Serve Sites) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the design's "Part A — Serve sites" into working code: a multi-tenant compose split (one shared Caddy + per-site mdz/sidecar projects), the deterministic glue that renders/validates per-site config, and the two operator skills `/setup` and `/add-mdz-site` — so each GitHub content repo becomes a site at `<site>.<base-domain>` behind one shared proxy.

**Architecture:** Mirrors Phase 1's split: *pure, offline-testable logic in TypeScript* (`control/`, vitest) + *thin integration glue in bash* (`scripts/`) that shells out to `docker`/`git`/`ssh`/`gh`/`dig`/`curl` and is verified on a real server, not unit-tested. A single shared Caddy (project `mdz-edge-caddy`) is the only host-port binder; it routes via per-site snippet files imported from `platform/caddy/sites/*.caddy`. Each site is its own compose project `mdz-<site>` whose mdz joins the external `mdz_edge` network under the **unique alias `mdz-<site>`** and binds no host ports. Content lives under `sites/<site>/repo` (bind-mounted to mdz+sidecar); secrets live under `secrets/<site>/` (never mounted anywhere a future agent could read).

**Tech Stack:** Node 20 + TypeScript via `tsx` (no build step), `vitest`, `execa`; Docker Compose; Caddy 2 (HTTP-01 TLS, wildcard DNS); bash; `gh` CLI; `ssh-keygen`. Reuses the Phase 1 `docker/Dockerfile.mdz` and `docker/Dockerfile.sidecar` unchanged.

## Global Constraints

- **Pin `MDZ_REF=819bb83`** — the `mdz` main commit that includes Phase 2 magic-link auth + admin CLI. Use this exact value everywhere a default MDZ ref is needed.
- **Site name = DNS label.** Every site name must match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. The same string is the compose project (`mdz-<site>`), the network alias (`mdz-<site>`), and the Caddy snippet filename (`<site>.caddy`). Validate before any use.
- **Content vs secrets split is load-bearing.** `sites/<site>/repo` = content only; `secrets/<site>/` = deploy key + `.env` (JWT). Never put secrets under `sites/`. Both trees are gitignored.
- **Shared Caddy holds the certs.** Never `docker compose down -v` the `mdz-edge-caddy` project — `caddy_data` is the Let's Encrypt account/cert store; wiping it risks LE rate-limit lockout.
- **TS imports use `.js` extensions** (the repo is `module: NodeNext`). Tests live in `control/tests/`, run by `vitest`.
- **`BACKEND_URL` must be set per site** (`https://<site>.<base>`), or minted magic-links point at the wrong host. It is injected by `compose/docker-compose.site.yml` and overridden on the seed `docker exec`.
- **Bash scripts:** start with `set -euo pipefail` (via `lib/common.sh`), are idempotent, and validate the site name before acting.
- **Part B is out of scope here.** Agent provisioning (`/add-mdz-site` design step 8) and nanoclaw deploy (`/setup` design step 7) are deferred; the skills must contain an explicit `> Part B (deferred)` note where those hooks belong, and otherwise be complete for serving.

---

## File structure

```
mdz-ai-deploy/
├─ platform/                              # NEW — shared edge, brought up once by /setup
│  ├─ docker-compose.platform.yml         # shared Caddy; binds 80/443; external net mdz_edge
│  └─ caddy/
│     ├─ Caddyfile                        # global: ACME email + import sites/*.caddy
│     └─ sites/.gitkeep                    # per-site snippets land here (gitignored except .gitkeep)
├─ compose/
│  ├─ docker-compose.site.yml             # NEW — one site: mdz+sidecar, no host ports, alias mdz-${SITE_NAME}
│  ├─ site.env.example                    # NEW — per-site env template
│  ├─ docker-compose.yml                  # KEEP — offline/local single-site smoke stack
│  ├─ docker-compose.smoke.yml            # KEEP
│  └─ Caddyfile                           # KEEP — used only by the local smoke stack
├─ control/                               # NEW — pure, vitest-tested logic
│  ├─ src/{siteName.ts, render.ts, cli.ts}
│  └─ tests/{siteName.test.ts, render.test.ts, cli.test.ts}
├─ scripts/                               # NEW — thin integration glue (bash)
│  ├─ lib/common.sh
│  ├─ render-site-env.sh  register-route.sh  gen-deploy-key.sh       # offline-testable
│  ├─ platform-up.sh  detect-public-ip.sh  dns-check.sh  tls-selftest.sh
│  ├─ caddy-reload.sh  clone-content.sh  site-up.sh  wait-healthy.sh
│  └─ seed-admin.sh  add-deploy-key-github.sh                        # integration-only
├─ .claude/skills/
│  ├─ setup/SKILL.md                      # NEW
│  └─ add-mdz-site/SKILL.md               # NEW
├─ tsconfig.json                          # MODIFY — include control/**/*.ts
├─ vitest.config.ts                       # MODIFY — include control/tests
└─ .gitignore                             # MODIFY — sites/, secrets/, platform/caddy/sites/*.caddy
```

**Interfaces locked here (used by later tasks):**

```ts
// control/src/siteName.ts
export function validateSiteName(name: string): string;   // returns name; throws Error if not a DNS label

// control/src/render.ts
export interface SiteEnvInputs {
  site: string; baseDomain: string; contentRepo: string; mdzRef: string;
  jwtSecret: string; branch?: string; pagesSubdir?: string;
}
export function siteDomain(site: string, baseDomain: string): string;        // `${site}.${baseDomain}`
export function renderSiteEnv(i: SiteEnvInputs): string;                      // full secrets/<site>/.env body
export function renderCaddySnippet(domain: string, site: string): string;    // `${domain} {\n\treverse_proxy mdz-${site}:3001\n}\n`
```

```
# control/src/cli.ts — invoked as: node --import tsx/esm control/src/cli.ts <cmd> [--flag=val ...]
site-name      --site
site-domain    --site --base
render-env     --site --base --repo --ref --jwt [--branch] [--pages]
render-snippet --domain --site
```

```bash
# scripts/lib/common.sh exports: REPO_ROOT, log(), warn(), die(), require_cmd(), ctl()
ctl <cmd> [--flag=val ...]   # runs control/src/cli.ts via tsx
```

---

## Task 1: Multi-tenant scaffolding + gitignore + site.env.example

**Files:**
- Create: `platform/caddy/sites/.gitkeep` (empty)
- Create: `compose/site.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: the `sites/` and `secrets/` ignore rules and the `platform/caddy/sites/` snippet dir every later task and script writes into.

- [ ] **Step 1: Create the snippet directory placeholder**

Create an empty file `platform/caddy/sites/.gitkeep` (so the dir is tracked while its `*.caddy` contents are ignored).

- [ ] **Step 2: Append ignore rules to `.gitignore`**

Append these lines to the existing `.gitignore`. The `sites/`/`secrets/` patterns are **root-anchored with a leading `/`** — an unanchored `sites/` would also match `platform/caddy/sites/`, and once that parent dir is excluded the `!.gitkeep` negation can't re-include it.

```
# control-plane per-site state (never committed)
/sites/
/secrets/
platform/caddy/sites/*.caddy
!platform/caddy/sites/.gitkeep
```

- [ ] **Step 3: Create `compose/site.env.example`**

```bash
# Per-site env. /add-mdz-site renders this into secrets/<site>/.env (gitignored, chmod 600).
# --- identity ---
SITE_NAME=demo
BASE_DOMAIN=example.com
MDZ_REF=819bb83          # mdz commit incl. Phase 2 magic-link auth + admin CLI
# --- content ---
CONTENT_REPO=git@github.com:owner/repo.git
SYNC_BRANCH=main
PAGES_SUBDIR=pages
# --- secrets ---
JWT_SECRET=change-me     # openssl rand -hex 32
# --- sync sidecar ---
SYNC_BOT_NAME=mdz-bot
SYNC_BOT_EMAIL=bot@mdz.local
SYNC_DEBOUNCE_MS=5000
SYNC_POLL_MS=45000
SYNC_EXCLUDE=.auth/,.settings/
```

- [ ] **Step 4: Verify ignore rules work**

Run:
```bash
mkdir -p sites/demo secrets/demo platform/caddy/sites
touch sites/demo/x secrets/demo/.env platform/caddy/sites/demo.caddy
git status --porcelain --ignored sites secrets platform/caddy/sites
git check-ignore sites/demo/x secrets/demo/.env platform/caddy/sites/demo.caddy
git check-ignore platform/caddy/sites/.gitkeep && echo "BUG: gitkeep ignored" || echo "gitkeep tracked OK"
rm -rf sites secrets platform/caddy/sites/demo.caddy
```
Expected: the three test paths are reported ignored by `git check-ignore`; `.gitkeep` is **not** ignored ("gitkeep tracked OK"); `git status` shows `platform/caddy/sites/.gitkeep` and `compose/site.env.example` as the only new tracked files.

- [ ] **Step 5: Commit**

```bash
git add .gitignore platform/caddy/sites/.gitkeep compose/site.env.example
git commit -m "feat(control): scaffold multi-tenant dirs, gitignore, site env template"
```

---

## Task 2: Shared platform (Caddy) compose + global Caddyfile

**Files:**
- Create: `platform/docker-compose.platform.yml`
- Create: `platform/caddy/Caddyfile`

**Interfaces:**
- Produces: project `mdz-edge-caddy` binding host `:80/:443`, joined to external network `mdz_edge`, importing `caddy/sites/*.caddy`. Consumes env `ACME_EMAIL`.

- [ ] **Step 1: Create `platform/caddy/Caddyfile`**

```
{
	email {$ACME_EMAIL}
}

import /etc/caddy/sites/*.caddy
```

(An empty `sites/` glob is not an error in Caddy — it simply imports nothing until the first site is added.)

- [ ] **Step 2: Create `platform/docker-compose.platform.yml`**

```yaml
# Shared edge proxy for ALL sites — the ONLY container that binds host ports.
# Brought up once by /setup as project `mdz-edge-caddy`. Per-site mdz backends
# join the external network `mdz_edge`; Caddy routes to them via per-site
# snippets dropped into caddy/sites/ and a `caddy reload`.
#
# NEVER `down -v` this project: caddy_data holds the Let's Encrypt certs/account.
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      ACME_EMAIL: ${ACME_EMAIL}
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/sites:/etc/caddy/sites:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - mdz_edge

networks:
  mdz_edge:
    external: true

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Validate compose syntax (no daemon needed)**

Run:
```bash
ACME_EMAIL=ops@example.com docker compose \
  --project-directory platform -f platform/docker-compose.platform.yml config -q \
  && echo "PARSE OK"
```
Expected: `PARSE OK` (no errors). The `external: true` network is fine at config time.

- [ ] **Step 4: Commit**

```bash
git add platform/docker-compose.platform.yml platform/caddy/Caddyfile
git commit -m "feat(control): shared Caddy platform on external mdz_edge network"
```

---

## Task 3: Per-site compose (mdz + sidecar, no host ports)

**Files:**
- Create: `compose/docker-compose.site.yml`
- Modify: `compose/docker-compose.yml` (one clarifying header comment line)

**Interfaces:**
- Consumes (env, from `secrets/<site>/.env`): `SITE_NAME`, `BASE_DOMAIN`, `MDZ_REF`, `PAGES_SUBDIR`, `JWT_SECRET`, `SYNC_BRANCH`, `SYNC_BOT_NAME`, `SYNC_BOT_EMAIL`, `SYNC_DEBOUNCE_MS`, `SYNC_POLL_MS`, `SYNC_EXCLUDE`.
- Produces: project `mdz-<site>` with mdz reachable as `mdz-${SITE_NAME}:3001` on `mdz_edge`; binds `../sites/${SITE_NAME}/repo` and `../secrets/${SITE_NAME}/deploy_key`.

- [ ] **Step 1: Create `compose/docker-compose.site.yml`**

```yaml
# One MDZ site (mdz + sync sidecar). Brought up per-site by /add-mdz-site as
# project `mdz-<site>`:
#   docker compose -p mdz-<site> --project-directory compose \
#     --env-file ../secrets/<site>/.env -f compose/docker-compose.site.yml up -d --build
# Binds NO host ports: traffic arrives via the shared platform Caddy over the
# external `mdz_edge` network, which reaches this mdz as `mdz-${SITE_NAME}:3001`.
services:
  mdz:
    build:
      context: ..
      dockerfile: docker/Dockerfile.mdz
      args:
        MDZ_REF: ${MDZ_REF}
    image: mdz-app:${MDZ_REF}
    restart: unless-stopped
    environment:
      PAGES_ROOT: /data/repo/${PAGES_SUBDIR}
      JWT_SECRET: ${JWT_SECRET}
      BACKEND_URL: https://${SITE_NAME}.${BASE_DOMAIN}
      PORT: "3001"
      HOST: 0.0.0.0
    volumes:
      - ../sites/${SITE_NAME}/repo:/data/repo
    depends_on:
      sidecar:
        condition: service_started
    networks:
      mdz_edge:
        aliases:
          - mdz-${SITE_NAME}
    expose:
      - "3001"

  sidecar:
    build:
      context: ..
      dockerfile: docker/Dockerfile.sidecar
    image: mdz-sidecar:latest
    restart: unless-stopped
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
      - ../sites/${SITE_NAME}/repo:/data/repo
      - ../secrets/${SITE_NAME}/deploy_key:/keys/deploy_key:ro

networks:
  mdz_edge:
    external: true
```

- [ ] **Step 2: Mark the legacy single-site compose as local-only**

Replace the first line of `compose/docker-compose.yml` (currently `# The shared \`repo\` volume must be populated...`) by inserting one new line **above** it:

```
# LOCAL/SMOKE single-site stack (self-contained: own Caddy + named volume). For
# production multi-tenant serving use platform/ + compose/docker-compose.site.yml.
```

(Leave the rest of the file unchanged; the Phase 1 smoke test still uses it.)

- [ ] **Step 3: Validate the site compose parses and resolves the alias**

Run:
```bash
SITE_NAME=demo BASE_DOMAIN=example.com MDZ_REF=819bb83 PAGES_SUBDIR=pages \
  JWT_SECRET=x SYNC_BRANCH=main SYNC_BOT_NAME=mdz-bot SYNC_BOT_EMAIL=bot@mdz.local \
  SYNC_DEBOUNCE_MS=5000 SYNC_POLL_MS=45000 SYNC_EXCLUDE=.auth/,.settings/ \
  docker compose --project-directory compose -f compose/docker-compose.site.yml config \
  | grep -E "mdz-demo|BACKEND_URL|aliases|/data/repo" | head
```
Expected: output shows the alias `mdz-demo`, `BACKEND_URL: https://demo.example.com`, and the `sites/demo/repo` + `secrets/demo/deploy_key` bind mounts. No parse error.

- [ ] **Step 4: Commit**

```bash
git add compose/docker-compose.site.yml compose/docker-compose.yml
git commit -m "feat(control): per-site compose (mdz+sidecar) on mdz_edge, no host ports"
```

---

## Task 4: Pure control logic — site-name validation + renderers

**Files:**
- Create: `control/src/siteName.ts`
- Create: `control/src/render.ts`
- Test: `control/tests/siteName.test.ts`, `control/tests/render.test.ts`
- Modify: `tsconfig.json`, `vitest.config.ts`

**Interfaces:**
- Produces: `validateSiteName`, `siteDomain`, `renderSiteEnv`, `renderCaddySnippet` (signatures in the locked-interfaces block above). Consumed by Task 5 (cli) and the bash scripts.

- [ ] **Step 1: Wire the new TS tree into config**

In `tsconfig.json`, change the `include` array to:
```json
  "include": ["sidecar/**/*.ts", "control/**/*.ts"]
```
In `vitest.config.ts`, change the `include` array to:
```ts
    include: ["sidecar/tests/**/*.test.ts", "control/tests/**/*.test.ts"],
```

- [ ] **Step 2: Write failing tests for `validateSiteName` (`control/tests/siteName.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { validateSiteName } from "../src/siteName.js";

describe("validateSiteName", () => {
  it("accepts valid DNS labels", () => {
    for (const ok of ["demo", "a", "site-1", "x9", "a-b-c", "a".repeat(63)]) {
      expect(validateSiteName(ok)).toBe(ok);
    }
  });
  it("rejects invalid names", () => {
    for (const bad of ["", "Demo", "-demo", "demo-", "a.b", "a_b", "a".repeat(64), "déjà"]) {
      expect(() => validateSiteName(bad)).toThrow();
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run control/tests/siteName.test.ts`
Expected: FAIL — cannot resolve `../src/siteName.js`.

- [ ] **Step 4: Implement `control/src/siteName.ts`**

```ts
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSiteName(name: string): string {
  if (!DNS_LABEL.test(name)) {
    throw new Error(
      `invalid site name "${name}": must be a DNS label ` +
        `(lowercase a-z, 0-9, hyphens; 1-63 chars; no leading/trailing hyphen)`
    );
  }
  return name;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run control/tests/siteName.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write failing tests for renderers (`control/tests/render.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { siteDomain, renderSiteEnv, renderCaddySnippet } from "../src/render.js";

describe("siteDomain", () => {
  it("joins site and base", () => {
    expect(siteDomain("demo", "example.com")).toBe("demo.example.com");
  });
  it("validates the site name", () => {
    expect(() => siteDomain("Bad", "example.com")).toThrow();
  });
});

describe("renderCaddySnippet", () => {
  it("emits a reverse_proxy block targeting the per-site alias", () => {
    expect(renderCaddySnippet("demo.example.com", "demo")).toBe(
      "demo.example.com {\n\treverse_proxy mdz-demo:3001\n}\n"
    );
  });
});

describe("renderSiteEnv", () => {
  const base = {
    site: "demo", baseDomain: "example.com",
    contentRepo: "git@github.com:owner/repo.git", mdzRef: "819bb83", jwtSecret: "deadbeef",
  };
  it("renders required keys and defaults", () => {
    const env = renderSiteEnv(base);
    expect(env).toContain("SITE_NAME=demo");
    expect(env).toContain("BASE_DOMAIN=example.com");
    expect(env).toContain("MDZ_REF=819bb83");
    expect(env).toContain("CONTENT_REPO=git@github.com:owner/repo.git");
    expect(env).toContain("JWT_SECRET=deadbeef");
    expect(env).toContain("SYNC_BRANCH=main");
    expect(env).toContain("PAGES_SUBDIR=pages");
    expect(env).toContain("SYNC_EXCLUDE=.auth/,.settings/");
    expect(env.endsWith("\n")).toBe(true);
  });
  it("honors branch/pages overrides", () => {
    const env = renderSiteEnv({ ...base, branch: "dev", pagesSubdir: "wiki" });
    expect(env).toContain("SYNC_BRANCH=dev");
    expect(env).toContain("PAGES_SUBDIR=wiki");
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run control/tests/render.test.ts`
Expected: FAIL — cannot resolve `../src/render.js`.

- [ ] **Step 8: Implement `control/src/render.ts`**

```ts
import { validateSiteName } from "./siteName.js";

export interface SiteEnvInputs {
  site: string;
  baseDomain: string;
  contentRepo: string;
  mdzRef: string;
  jwtSecret: string;
  branch?: string;
  pagesSubdir?: string;
}

export function siteDomain(site: string, baseDomain: string): string {
  return `${validateSiteName(site)}.${baseDomain}`;
}

export function renderSiteEnv(i: SiteEnvInputs): string {
  validateSiteName(i.site);
  const branch = i.branch ?? "main";
  const pagesSubdir = i.pagesSubdir ?? "pages";
  return (
    [
      `SITE_NAME=${i.site}`,
      `BASE_DOMAIN=${i.baseDomain}`,
      `MDZ_REF=${i.mdzRef}`,
      `CONTENT_REPO=${i.contentRepo}`,
      `SYNC_BRANCH=${branch}`,
      `PAGES_SUBDIR=${pagesSubdir}`,
      `JWT_SECRET=${i.jwtSecret}`,
      `SYNC_BOT_NAME=mdz-bot`,
      `SYNC_BOT_EMAIL=bot@mdz.local`,
      `SYNC_DEBOUNCE_MS=5000`,
      `SYNC_POLL_MS=45000`,
      `SYNC_EXCLUDE=.auth/,.settings/`,
    ].join("\n") + "\n"
  );
}

export function renderCaddySnippet(domain: string, site: string): string {
  validateSiteName(site);
  return `${domain} {\n\treverse_proxy mdz-${site}:3001\n}\n`;
}
```

- [ ] **Step 9: Run the full suite to verify green (incl. Phase 1)**

Run: `npm test`
Expected: PASS — `sidecar/` (19) + `control/` (siteName + render) tests all green.

- [ ] **Step 10: Commit**

```bash
git add tsconfig.json vitest.config.ts control/src/siteName.ts control/src/render.ts control/tests/siteName.test.ts control/tests/render.test.ts
git commit -m "feat(control): site-name validation + env/caddy renderers (TDD)"
```

---

## Task 5: Control CLI (`control/src/cli.ts`)

**Files:**
- Create: `control/src/cli.ts`
- Test: `control/tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 4 renderers.
- Produces: the `ctl` entrypoint scripts call — subcommands `site-name`, `site-domain`, `render-env`, `render-snippet` printing to stdout; exits non-zero with a message on bad/unknown input.

- [ ] **Step 1: Write failing tests (`control/tests/cli.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { execa } from "execa";

const RUN = (args: string[]) =>
  execa("node", ["--import", "tsx/esm", "control/src/cli.ts", ...args]);

describe("control cli", () => {
  it("site-domain prints <site>.<base>", async () => {
    const { stdout } = await RUN(["site-domain", "--site=demo", "--base=example.com"]);
    expect(stdout).toBe("demo.example.com");
  });
  it("render-snippet prints a caddy block", async () => {
    const { stdout } = await RUN(["render-snippet", "--domain=demo.example.com", "--site=demo"]);
    expect(stdout).toBe("demo.example.com {\n\treverse_proxy mdz-demo:3001\n}");
  });
  it("render-env includes required keys", async () => {
    const { stdout } = await RUN([
      "render-env", "--site=demo", "--base=example.com",
      "--repo=git@github.com:owner/repo.git", "--ref=819bb83", "--jwt=deadbeef",
    ]);
    expect(stdout).toContain("SITE_NAME=demo");
    expect(stdout).toContain("JWT_SECRET=deadbeef");
  });
  it("rejects an invalid site name (non-zero exit)", async () => {
    await expect(RUN(["site-name", "--site=Bad_Name"])).rejects.toThrow();
  });
  it("rejects an unknown command", async () => {
    await expect(RUN(["bogus"])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run control/tests/cli.test.ts`
Expected: FAIL — cannot resolve `control/src/cli.ts`.

- [ ] **Step 3: Implement `control/src/cli.ts`**

```ts
import { validateSiteName } from "./siteName.js";
import { siteDomain, renderSiteEnv, renderCaddySnippet } from "./render.js";

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.slice(3).find((a) => a.startsWith(pfx));
  return hit?.slice(pfx.length);
}
function req(name: string): string {
  const v = arg(name);
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

function main(): void {
  const cmd = process.argv[2];
  switch (cmd) {
    case "site-name":
      process.stdout.write(validateSiteName(req("site")) + "\n");
      break;
    case "site-domain":
      process.stdout.write(siteDomain(req("site"), req("base")) + "\n");
      break;
    case "render-env":
      process.stdout.write(
        renderSiteEnv({
          site: req("site"), baseDomain: req("base"), contentRepo: req("repo"),
          mdzRef: req("ref"), jwtSecret: req("jwt"),
          branch: arg("branch"), pagesSubdir: arg("pages"),
        })
      );
      break;
    case "render-snippet":
      process.stdout.write(renderCaddySnippet(req("domain"), req("site")));
      break;
    default:
      throw new Error(
        `unknown command: ${cmd ?? "(none)"}\n` +
          "commands: site-name, site-domain, render-env, render-snippet"
      );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\n");
  process.exit(1);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run control/tests/cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add control/src/cli.ts control/tests/cli.test.ts
git commit -m "feat(control): cli dispatch over site-name/domain/env/snippet renderers"
```

---

## Task 6: Script lib + offline-testable scripts

**Files:**
- Create: `scripts/lib/common.sh`
- Create: `scripts/render-site-env.sh`, `scripts/register-route.sh`, `scripts/gen-deploy-key.sh`
- Test: `control/tests/scripts.test.ts` (drives the three scripts end-to-end in a temp `REPO_ROOT`-style layout — they only touch the filesystem + `ssh-keygen`, no docker)

**Interfaces:**
- Consumes: `ctl` (Task 5).
- Produces: `secrets/<site>/.env` (mode 600), `secrets/<site>/deploy_key`(+`.pub`, mode 600), `platform/caddy/sites/<site>.caddy`.

- [ ] **Step 1: Create `scripts/lib/common.sh`**

```bash
# Shared helpers for control-plane scripts. Source at top:
#   . "$(dirname "$0")/lib/common.sh"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log()  { printf '\033[1;34m[ctl]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[ctl]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ctl] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

# Run the control TS CLI: ctl <subcommand> [--flag=val ...]
ctl() { node --import tsx/esm "$REPO_ROOT/control/src/cli.ts" "$@"; }
```

- [ ] **Step 2: Create `scripts/render-site-env.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node openssl
# usage: render-site-env.sh <site> <base_domain> <content_repo> <mdz_ref> [branch]
site="${1:?site}"; base="${2:?base_domain}"; repo="${3:?content_repo}"; ref="${4:?mdz_ref}"; branch="${5:-main}"
ctl site-name --site="$site" >/dev/null
dir="$REPO_ROOT/secrets/$site"; mkdir -p "$dir"
jwt="$(openssl rand -hex 32)"
ctl render-env --site="$site" --base="$base" --repo="$repo" --ref="$ref" --jwt="$jwt" --branch="$branch" > "$dir/.env"
chmod 600 "$dir/.env"
log "wrote $dir/.env"
```

- [ ] **Step 3: Create `scripts/register-route.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: register-route.sh <site> <domain>   (writes the snippet only; caller runs caddy-reload.sh)
site="${1:?site}"; domain="${2:?domain}"
ctl site-name --site="$site" >/dev/null
dest="$REPO_ROOT/platform/caddy/sites/$site.caddy"; mkdir -p "$(dirname "$dest")"
ctl render-snippet --domain="$domain" --site="$site" > "$dest"
log "wrote $dest"
```

- [ ] **Step 4: Create `scripts/gen-deploy-key.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd ssh-keygen node
# usage: gen-deploy-key.sh <site>
site="${1:?site}"
ctl site-name --site="$site" >/dev/null
dir="$REPO_ROOT/secrets/$site"; mkdir -p "$dir"
key="$dir/deploy_key"
if [ -f "$key" ]; then log "deploy key exists: $key"; exit 0; fi
ssh-keygen -t ed25519 -N "" -C "mdz-$site-deploy" -f "$key" >/dev/null
chmod 600 "$key"
log "generated $key (+ $key.pub)"
```

- [ ] **Step 5: Make the scripts executable**

Run: `chmod +x scripts/*.sh`

- [ ] **Step 6: Write the failing test (`control/tests/scripts.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtempSync, rmSync, readFileSync, existsSync, cpSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build a throwaway REPO_ROOT containing only what the scripts need: control/ + scripts/.
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ctl-scripts-"));
  cpSync(join(process.cwd(), "control"), join(root, "control"), { recursive: true });
  cpSync(join(process.cwd(), "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), { recursive: true });
  cpSync(join(process.cwd(), "package.json"), join(root, "package.json"));
  return root;
}

describe("offline control scripts", () => {
  let root: string;
  beforeEach(() => { root = fakeRepo(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("render-site-env writes a 600 .env with the right keys", async () => {
    await execa("bash", ["scripts/render-site-env.sh", "demo", "example.com", "git@github.com:o/r.git", "819bb83"], { cwd: root });
    const env = join(root, "secrets/demo/.env");
    expect(existsSync(env)).toBe(true);
    expect(readFileSync(env, "utf8")).toContain("SITE_NAME=demo");
    expect((statSync(env).mode & 0o777).toString(8)).toBe("600");
  });

  it("gen-deploy-key writes a 600 ed25519 key pair, idempotently", async () => {
    await execa("bash", ["scripts/gen-deploy-key.sh", "demo"], { cwd: root });
    const key = join(root, "secrets/demo/deploy_key");
    expect(existsSync(key)).toBe(true);
    expect(existsSync(key + ".pub")).toBe(true);
    expect((statSync(key).mode & 0o777).toString(8)).toBe("600");
    await execa("bash", ["scripts/gen-deploy-key.sh", "demo"], { cwd: root }); // no throw on re-run
  });

  it("register-route writes a caddy snippet for the site", async () => {
    await execa("bash", ["scripts/register-route.sh", "demo", "demo.example.com"], { cwd: root });
    const snip = readFileSync(join(root, "platform/caddy/sites/demo.caddy"), "utf8");
    expect(snip).toBe("demo.example.com {\n\treverse_proxy mdz-demo:3001\n}\n");
  });

  it("rejects an invalid site name", async () => {
    await expect(
      execa("bash", ["scripts/gen-deploy-key.sh", "Bad_Name"], { cwd: root })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run control/tests/scripts.test.ts`
Expected: PASS (4 tests). (The copy of `node_modules` lets `tsx` resolve inside the temp repo; the test timeout is the config's 20s.)

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/common.sh scripts/render-site-env.sh scripts/register-route.sh scripts/gen-deploy-key.sh control/tests/scripts.test.ts
git commit -m "feat(control): script lib + offline-testable env/route/deploy-key scripts"
```

---

## Task 7: Integration scripts (docker / network / dns / tls)

These touch docker, the network, DNS, ACME, or `gh` and cannot run in this sandbox; they are **syntax-checked here** (`bash -n`) and **verified on the server** via `/setup` + `/add-mdz-site`. Each is idempotent and validates inputs.

**Files (all Create, all `chmod +x`):**
- `scripts/platform-up.sh`, `scripts/detect-public-ip.sh`, `scripts/dns-check.sh`, `scripts/tls-selftest.sh`, `scripts/caddy-reload.sh`, `scripts/clone-content.sh`, `scripts/site-up.sh`, `scripts/wait-healthy.sh`, `scripts/seed-admin.sh`, `scripts/add-deploy-key-github.sh`

- [ ] **Step 1: `scripts/platform-up.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
: "${ACME_EMAIL:?ACME_EMAIL required (export it before calling)}"
docker network inspect mdz_edge >/dev/null 2>&1 || docker network create mdz_edge
docker compose -p mdz-edge-caddy --project-directory "$REPO_ROOT/platform" \
  -f "$REPO_ROOT/platform/docker-compose.platform.yml" up -d
log "platform (shared Caddy) up on mdz_edge"
```

- [ ] **Step 2: `scripts/detect-public-ip.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd curl
ip="$(curl -fsS https://api.ipify.org || true)"
[ -n "$ip" ] || ip="$(curl -fsS https://ifconfig.me || true)"
[ -n "$ip" ] || die "could not detect public IP"
printf '%s\n' "$ip"
```

- [ ] **Step 3: `scripts/dns-check.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd dig
# usage: dns-check.sh <probe_host> <expected_ip>
host="${1:?probe_host}"; ip="${2:?expected_ip}"
resolved="$(dig +short "$host" A | tr '\n' ' ')"
log "$host A => ${resolved:-(none)}"
echo "$resolved" | tr ' ' '\n' | grep -qx "$ip" \
  && { log "DNS OK ($host -> $ip)"; exit 0; } \
  || { warn "DNS not pointing at $ip yet"; exit 1; }
```

- [ ] **Step 4: `scripts/caddy-reload.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
docker compose -p mdz-edge-caddy exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose -p mdz-edge-caddy exec -T caddy caddy reload --config /etc/caddy/Caddyfile
log "caddy validated + reloaded"
```

- [ ] **Step 5: `scripts/tls-selftest.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker curl
# usage: tls-selftest.sh <base_domain>   (fixed probe host spares LE rate limits)
base="${1:?base_domain}"
host="mdz-selftest.$base"
snip="$REPO_ROOT/platform/caddy/sites/zz-selftest.caddy"
printf '%s {\n\trespond "ok" 200\n}\n' "$host" > "$snip"
"$REPO_ROOT/scripts/caddy-reload.sh"
ok=1
for _ in $(seq 1 20); do
  curl -fsS "https://$host" >/dev/null 2>&1 && { ok=0; break; }
  sleep 3
done
rm -f "$snip"; "$REPO_ROOT/scripts/caddy-reload.sh"
[ "$ok" = 0 ] && log "TLS self-test passed (real cert on $host)" || die "TLS self-test failed for $host"
```

- [ ] **Step 6: `scripts/gen` GitHub deploy-key registration — `scripts/add-deploy-key-github.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd gh
# usage: add-deploy-key-github.sh <site> <owner/repo>
site="${1:?site}"; slug="${2:?owner/repo}"
pub="$REPO_ROOT/secrets/$site/deploy_key.pub"
[ -f "$pub" ] || die "missing $pub (run gen-deploy-key.sh first)"
gh repo deploy-key add "$pub" --repo "$slug" --title "mdz-$site" --allow-write \
  || warn "gh deploy-key add failed; add $pub to $slug manually with WRITE access"
```

- [ ] **Step 7: `scripts/clone-content.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd git node
# usage: clone-content.sh <site> <content_repo> [branch]
site="${1:?site}"; repo="${2:?content_repo}"; branch="${3:-main}"
ctl site-name --site="$site" >/dev/null
key="$REPO_ROOT/secrets/$site/deploy_key"
[ -f "$key" ] || die "missing deploy key $key (run gen-deploy-key.sh first)"
dest="$REPO_ROOT/sites/$site/repo"
if [ -d "$dest/.git" ]; then
  log "content already cloned at $dest"
else
  mkdir -p "$REPO_ROOT/sites/$site"
  GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git clone --branch "$branch" "$repo" "$dest"
fi
[ -d "$dest/pages" ] || die "content repo has no pages/ dir at $dest/pages"
if git -C "$dest" ls-files --error-unmatch pages/.settings/users.yaml >/dev/null 2>&1; then
  warn "pages/.settings/users.yaml is tracked; removing from index (file kept on disk)"
  git -C "$dest" rm --cached -q pages/.settings/users.yaml
fi
log "content ready at $dest"
```

- [ ] **Step 8: `scripts/site-up.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker node
# usage: site-up.sh <site>
site="${1:?site}"
ctl site-name --site="$site" >/dev/null
env="$REPO_ROOT/secrets/$site/.env"; [ -f "$env" ] || die "missing $env (run render-site-env.sh)"
key="$REPO_ROOT/secrets/$site/deploy_key"; [ -f "$key" ] || die "missing deploy key $key"
mode="$(stat -f '%Lp' "$key" 2>/dev/null || stat -c '%a' "$key")"
[ "$mode" = "600" ] || die "deploy key must be chmod 600 (is $mode): $key"
docker compose -p "mdz-$site" --project-directory "$REPO_ROOT/compose" \
  --env-file "$env" -f "$REPO_ROOT/compose/docker-compose.site.yml" up -d --build
log "site mdz-$site up"
```

- [ ] **Step 9: `scripts/wait-healthy.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
# usage: wait-healthy.sh <project> [tries] [sleep_s]   e.g. wait-healthy.sh mdz-demo
proj="${1:?project (e.g. mdz-demo)}"; tries="${2:-30}"; gap="${3:-2}"
probe='fetch("http://localhost:3001/api/health").then(r=>r.json()).then(j=>{if(j.status!=="ok")process.exit(1)}).catch(()=>process.exit(1))'
for _ in $(seq 1 "$tries"); do
  docker compose -p "$proj" exec -T mdz node -e "$probe" 2>/dev/null && { log "$proj healthy"; exit 0; }
  sleep "$gap"
done
die "$proj not healthy after $((tries*gap))s"
```

- [ ] **Step 10: `scripts/seed-admin.sh`**

```bash
#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
# usage: seed-admin.sh <site> <owner_email>   (prints the magic link)
site="${1:?site}"; email="${2:?owner_email}"
env="$REPO_ROOT/secrets/$site/.env"; [ -f "$env" ] || die "missing $env"
base="$(grep -E '^BASE_DOMAIN=' "$env" | cut -d= -f2-)"
domain="$site.$base"
docker compose -p "mdz-$site" exec -T -e "BACKEND_URL=https://$domain" mdz \
  node packages/backend/dist/cli/admin.js add-user "$email" admins
```

- [ ] **Step 11: Make executable + syntax-check every script**

Run:
```bash
chmod +x scripts/*.sh
for s in scripts/*.sh; do bash -n "$s" && echo "ok: $s"; done
```
Expected: `ok: scripts/<name>.sh` for every script, no syntax errors.

- [ ] **Step 12: Commit**

```bash
git add scripts/platform-up.sh scripts/detect-public-ip.sh scripts/dns-check.sh scripts/tls-selftest.sh scripts/caddy-reload.sh scripts/add-deploy-key-github.sh scripts/clone-content.sh scripts/site-up.sh scripts/wait-healthy.sh scripts/seed-admin.sh
git commit -m "feat(control): integration scripts (platform/dns/tls/clone/up/health/seed)"
```

---

## Task 8: `/setup` skill

**Files:**
- Create: `.claude/skills/setup/SKILL.md`

**Interfaces:**
- Consumes: `scripts/platform-up.sh`, `detect-public-ip.sh`, `dns-check.sh`, `tls-selftest.sh`.
- Produces: a running `mdz-edge-caddy` platform + verified wildcard DNS + TLS, ready for `/add-mdz-site`.

- [ ] **Step 1: Write `.claude/skills/setup/SKILL.md`**

````markdown
---
name: setup
description: Bootstrap a VPS once to host MDZ sites — shared Caddy edge on the mdz_edge network, wildcard DNS, and a real-cert TLS self-test. Run this before /add-mdz-site.
---

# /setup — bootstrap the server (once)

Run from the `mdz-ai-deploy` repo root on the target server. Idempotent; safe to re-run.

## 1. Preflight
- `npm install` (installs `tsx`/`vitest`/`execa` the scripts need).
- `docker info` — Docker must be running. If `:80`/`:443` are already bound (leftover nginx/apache/certbot), stop that service first; the shared Caddy must own those ports.

## 2. Inputs (AskUserQuestion)
- **Base domain** (e.g. `example.com`) — sites become `<site>.<base>`.
- **ACME email** — for Let's Encrypt.
- *(Part B, collected later: Telegram bot token + Claude auth for nanoclaw.)*

## 3. Bring up the platform
```bash
export ACME_EMAIL=<acme-email>
scripts/platform-up.sh
```
Creates the external `mdz_edge` network (idempotent) and starts the shared Caddy as project `mdz-edge-caddy`.

## 4. Wildcard DNS
```bash
scripts/detect-public-ip.sh         # prints <ip>
```
Tell the operator to add a DNS record `*.<base>  A  <ip>` (and `<base> A <ip>` if they want the apex). Wait for confirmation.

## 5. Verify DNS
```bash
scripts/dns-check.sh mdz-selftest.<base> <ip>
```
Re-run until it prints `DNS OK` (propagation can take minutes).

## 6. TLS self-test (real cert, fixed probe host)
```bash
scripts/tls-selftest.sh <base>
```
Expects `TLS self-test passed`. Uses the fixed host `mdz-selftest.<base>` to spare LE rate limits, then removes the probe snippet.

## 7. Report
Confirm: platform up, `mdz_edge` exists, DNS resolves, TLS chain valid. The server is ready for `/add-mdz-site`.

> **Part B (deferred):** deploying the host nanoclaw service (Claude auth, Telegram token, mount allowlist) belongs to the agents phase and is not done here yet.
````

- [ ] **Step 2: Validate frontmatter + script references**

Run:
```bash
head -4 .claude/skills/setup/SKILL.md
grep -oE 'scripts/[a-z-]+\.sh' .claude/skills/setup/SKILL.md | sort -u | while read -r s; do test -f "$s" && echo "ref ok: $s" || echo "MISSING: $s"; done
```
Expected: frontmatter shows `name: setup` + a `description:`; every referenced script prints `ref ok`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/setup/SKILL.md
git commit -m "feat(skill): /setup bootstraps shared Caddy + wildcard DNS + TLS self-test"
```

---

## Task 9: `/add-mdz-site` skill

**Files:**
- Create: `.claude/skills/add-mdz-site/SKILL.md`

**Interfaces:**
- Consumes: `gen-deploy-key.sh`, `add-deploy-key-github.sh`, `render-site-env.sh`, `clone-content.sh`, `site-up.sh`, `wait-healthy.sh`, `seed-admin.sh`, `register-route.sh`, `caddy-reload.sh`.
- Produces: a live site at `https://<site>.<base>` with an `admins` owner + magic link.

- [ ] **Step 1: Write `.claude/skills/add-mdz-site/SKILL.md`**

````markdown
---
name: add-mdz-site
description: Stand up one MDZ site from a GitHub content repo — deploy key, per-site secrets, content clone, mdz+sidecar up, owner seed + magic link, and Caddy route. Requires /setup to have run.
---

# /add-mdz-site — add one site

Run from the `mdz-ai-deploy` repo root on a server already bootstrapped by `/setup`. Idempotent per site.

## 1. Preflight
- Shared platform up: `docker compose -p mdz-edge-caddy ps` shows Caddy running. If not, run `/setup`.

## 2. Inputs (AskUserQuestion)
- **Content repo** SSH URL (`git@github.com:owner/repo.git`) and its `owner/repo` slug.
- **Site name** — a DNS label (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`); becomes the subdomain, compose project, and Caddy snippet name.
- **Owner email** (seeded into `admins`).
- **Branch** (default `main`).
- **Base domain** — the value chosen in `/setup`.

If `sites/<site>/` or `secrets/<site>/` already exists, reconcile (re-run the steps below) rather than duplicating.

## 3. Deploy key + GitHub registration
```bash
scripts/gen-deploy-key.sh <site>
scripts/add-deploy-key-github.sh <site> <owner/repo>     # or add secrets/<site>/deploy_key.pub manually (write access)
```

## 4. Render per-site env
```bash
scripts/render-site-env.sh <site> <base> <content_repo> 819bb83 <branch>
```
Writes `secrets/<site>/.env` (`chmod 600`, fresh `JWT_SECRET`, `SYNC_EXCLUDE=.auth/,.settings/`).

## 5. Clone content
```bash
scripts/clone-content.sh <site> <content_repo> <branch>
```
Clones into `sites/<site>/repo`, asserts `pages/` exists, and untracks `pages/.settings/users.yaml` if it was committed (keeps member emails off GitHub).

## 6. Bring the site up + wait healthy
```bash
scripts/site-up.sh <site>
scripts/wait-healthy.sh mdz-<site>
```

## 7. Seed the owner + print the magic link
```bash
scripts/seed-admin.sh <site> <owner_email>
```
Runs the mdz admin CLI inside the container with `BACKEND_URL=https://<site>.<base>` so the printed `Magic link:` points at the real host. Deliver that link to the owner.

## 8. Route + TLS
```bash
scripts/register-route.sh <site> <site>.<base>
scripts/caddy-reload.sh
```
Writes `platform/caddy/sites/<site>.caddy` and reloads Caddy; the first HTTPS hit provisions the cert via HTTP-01.

## 9. Verify + report
```bash
curl --fail https://<site>.<base>/api/health     # {"status":"ok",...}
```
Report the site URL + the owner magic link.

> **Part B (deferred):** provisioning this site's general agent and minting its admin token (design step 8) belongs to the agents phase. The content/secrets split here (`sites/` vs `secrets/`) is what later lets a single admin agent mount all content without ever seeing deploy keys or `JWT_SECRET`.
````

- [ ] **Step 2: Validate frontmatter + script references**

Run:
```bash
head -4 .claude/skills/add-mdz-site/SKILL.md
grep -oE 'scripts/[a-z-]+\.sh' .claude/skills/add-mdz-site/SKILL.md | sort -u | while read -r s; do test -f "$s" && echo "ref ok: $s" || echo "MISSING: $s"; done
```
Expected: frontmatter shows `name: add-mdz-site` + a `description:`; every referenced script prints `ref ok`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-mdz-site/SKILL.md
git commit -m "feat(skill): /add-mdz-site provisions a site end-to-end (serve)"
```

---

## Task 10: Docs + whole-split validation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-06-29-control-plane-and-agents.md` (mark Part A status)
- Create: `docs/control-plane-serve.md` (operator overview)

- [ ] **Step 1: Create `docs/control-plane-serve.md`**

```markdown
# Control plane — serving sites (Part A)

Multi-tenant MDZ hosting on one VPS: a shared Caddy edge plus one compose project
per site. Two operator skills drive it.

## Layout
- `platform/` — shared Caddy (project `mdz-edge-caddy`), the only host-port binder; external network `mdz_edge`; routes via `platform/caddy/sites/*.caddy`.
- `compose/docker-compose.site.yml` — one site (mdz + sidecar), no host ports, mdz alias `mdz-<site>` on `mdz_edge`.
- `sites/<site>/repo` — content working tree (bind-mounted to mdz + sidecar). Gitignored.
- `secrets/<site>/` — deploy key + `.env` (JWT). Gitignored. Never mounted to an agent.
- `control/` — pure renderers/validation (vitest). `scripts/` — bash glue.

## Use
1. `/setup` — once per server (shared Caddy, wildcard DNS `*.<base> A <ip>`, TLS self-test).
2. `/add-mdz-site` — per site (deploy key → env → clone → up → seed owner → route).

## Notes
- Never `docker compose -p mdz-edge-caddy down -v` (caddy_data = LE certs).
- `MDZ_REF` is pinned to `819bb83` (mdz incl. Phase 2 auth).
- Member emails (`pages/.settings/users.yaml`) are kept off GitHub via `SYNC_EXCLUDE=.auth/,.settings/`.
- The local single-site smoke stack (`compose/docker-compose.yml` + `Caddyfile`) is unchanged and independent of this split.

Agents (general/admin) are Part B — not built yet.
```

- [ ] **Step 2: Update `README.md`** — add a "Control plane (serve)" bullet under Design, linking the two new docs:

Append to the Design list in `README.md`:
```markdown
- [Control plane — serving sites](docs/control-plane-serve.md) — `/setup` + `/add-mdz-site`
- [Combined control-plane + agents plan](docs/superpowers/plans/2026-06-29-control-plane-and-agents.md)
```

- [ ] **Step 3: Mark Part A status in the combined plan**

In `docs/superpowers/plans/2026-06-29-control-plane-and-agents.md`, under the `## Build order` section, change line 1 from:
```
1. **Part A serve** — split compose, the two serve skills + scripts; verify multi-site end-to-end (independently shippable).
```
to:
```
1. **Part A serve** — split compose, the two serve skills + scripts. **DONE** (see `docs/superpowers/plans/2026-06-29-control-plane-part-a-serve.md`); live multi-site verification is operator-run on the server.
```

- [ ] **Step 4: Whole-split config validation + full test suite**

Run:
```bash
ACME_EMAIL=ops@example.com docker compose --project-directory platform -f platform/docker-compose.platform.yml config -q && echo "platform OK"
SITE_NAME=demo BASE_DOMAIN=example.com MDZ_REF=819bb83 PAGES_SUBDIR=pages JWT_SECRET=x \
  SYNC_BRANCH=main SYNC_BOT_NAME=mdz-bot SYNC_BOT_EMAIL=bot@mdz.local \
  SYNC_DEBOUNCE_MS=5000 SYNC_POLL_MS=45000 SYNC_EXCLUDE=.auth/,.settings/ \
  docker compose --project-directory compose -f compose/docker-compose.site.yml config -q && echo "site OK"
npm test
```
Expected: `platform OK`, `site OK`, and the full vitest suite green (sidecar + control).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/control-plane-serve.md docs/superpowers/plans/2026-06-29-control-plane-and-agents.md
git commit -m "docs(control): serve overview, README links, mark Part A done"
```

---

## Self-review notes (author)

- **Spec coverage (design Part A):**
  - `/setup` once-per-server (Docker preflight, inputs, platform up, wildcard DNS, DNS verify, TLS self-test, report) → Task 8 (+ scripts in Tasks 6–7). nanoclaw deploy (design §B1 / setup step 7) → explicitly **deferred to Part B** in the skill.
  - `/add-mdz-site` (preflight, inputs, deploy key, render env, clone content, up+health, seed owner+link, route+TLS) → Task 9 (+ scripts). Agent provisioning (design step 8) → **deferred to Part B** note.
  - Compose split: shared Caddy on `mdz_edge` (Task 2), per-site project with unique alias `mdz-<site>`, no host ports, content bind-mount (Task 3). Correctness points 1–4 (single host binder; unique alias; snippet + validate/reload; HTTP-01 + wildcard DNS) are realized.
  - Content/secrets split (point 5) → Task 1 gitignore + Task 6/7 scripts writing `sites/` (content) vs `secrets/` (keys/env), never co-mounted.
  - Serve gotchas: `BACKEND_URL` set (Task 3 + seed-admin `-e`); never `down -v` Caddy (documented Tasks 2/10); deploy key exists + 600 before up (gen-deploy-key + site-up guard); gitignore `sites/`+`secrets/` (Task 1); per-site `SYNC_EXCLUDE` keeps member emails off GitHub (render-env + clone-content `git rm --cached`).
  - Helper scripts: every name in design §"Helper scripts" is present (Tasks 6–7) except `lib/common.sh` which is Task 6 Step 1.
- **Out of scope (correctly excluded):** Part B agents, nanoclaw + mdz code changes, `/add-agent`, token re-minter, `reconcile.ts`, `agents.yaml` — all design Part B.
- **Deliberate divergences from the design (flagged):**
  - Deterministic glue is split **TS (pure, tested) + bash (thin, integration)** rather than all-bash, matching Phase 1's proven, testable pattern. The design said "bash/ts glue" so this is within bounds.
  - `compose/docker-compose.yml` (single-site) is **kept** as the offline/local smoke stack (the design called it "superseded"); keeping it avoids breaking the Phase 1 smoke test and gives a no-network dev path. Production uses the new split.
- **Known follow-ups (not blockers):** `js-yaml` must be a prod dependency in the `mdz` backend image for `seed-admin.sh` to run (design "out of scope / known gaps"); verify with `docker run --rm mdz-app:819bb83 node packages/backend/dist/cli/admin.js list` during the first real `/add-mdz-site`. Live end-to-end verification (curl over real TLS, two-way sync, multi-site isolation) is operator-run on the server — not reproducible in this sandbox (Docker daemon down, no public IP/DNS).
- **Type/flag consistency:** `ctl` subcommands and flags (`site-name --site`; `site-domain --site --base`; `render-env --site --base --repo --ref --jwt [--branch][--pages]`; `render-snippet --domain --site`) match between `control/src/cli.ts` (Task 5) and every consuming script (Tasks 6–7). `SiteEnvInputs` field names match between `render.ts` (Task 4) and the cli mapping (Task 5).
```
