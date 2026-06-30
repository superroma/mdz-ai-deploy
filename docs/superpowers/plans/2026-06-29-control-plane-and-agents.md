# Control Plane + Agents — Combined Plan (spawn/serve sites + nanoclaw agents)

- **Date:** 2026-06-29
- **Status:** Draft (awaiting review)
- **Covers:** Phase 3 (control plane) + Phase 4 (agents) from `specs/2026-06-14-mdz-ai-deploy-design.md` §11
- **Repos touched:** `mdz-ai-deploy` (most), `mynanoclaw` (small), `mdz` (small)

## Context

`mdz-ai-deploy` hosts many collaborative MDZ wiki sites on one VPS. **Phase 1** (sync-sidecar + Compose + Caddy) and **Phase 2** (magic-link auth + admin API + CLI in `mdz`) are built, tested, and pushed. This plan adds everything else the operator needs, in one combined effort:

- **Serve:** a `/setup` skill (bootstrap the server once) and `/add-mdz-site` (repeatable) so each GitHub content repo becomes a site at `sitename.serverdomain.com` behind one shared proxy.
- **Agents:** every site gets a **general** agent (read-only over its pages); and **one server-wide admin** agent (not per-site — user's decision) that manages users across all sites and edits any general agent's instructions. One host nanoclaw serves them all.

**Decisions locked with the user:**
- Control plane = **on-demand Claude Code skills** in the forked repo (`.claude/skills/<name>/SKILL.md`, nanoclaw convention). No always-on control process; **skills reason/guide, deterministic scripts do the work.**
- **Wildcard DNS** `*.serverdomain.com → IP`, set once in `/setup`; adding a site needs no DNS.
- **Combined** plan: serve + agents together.
- **Single server-wide admin agent**; general agents are per-site.

**Spans three repos:** `mdz-ai-deploy` (skills/scripts/compose — most work), `mynanoclaw` (`~/work/mynanoclaw` — small generalizations + a per-agent-toolset change), `mdz` (one small auth change: short-lived admin tokens). The two-agent pattern is already proven in nanoclaw today (`zbadmin` rw + `zbmanager` ro for the existing zb-mdz site).

## Architecture

```
┌─ VPS ──────────────────────────────────────────────────────────────────┐
│ nanoclaw (native launchd/systemd service): 1 process, routes chats →    │
│   per-message container agents.  store/ DB, one Telegram bot token.      │
│     • general agent per site  (container, RO on that site's pages)       │
│     • ONE admin agent          (container, RW on all sites' content)     │
│                                                                          │
│ platform project: mdz-edge-caddy (binds 80/443, on net mdz_edge)         │
│   Caddyfile: import sites/*.caddy   caddy_data = certs                    │
│        │ reverse_proxy mdz-<site>:3001                                    │
│  ┌─────┴ project mdz-alpha ┐  ┌ project mdz-bravo ┐                       │
│  │ mdz(alias mdz-alpha)+sidecar │ …same…          │ …                    │
│  └──────────────────────────────┘                                        │
│                                                                          │
│ sites/<site>/repo/   = content working tree (bind-mounted to mdz+sidecar;│
│                        mounted to agents). NO secrets under here.         │
│ secrets/<site>/      = .env, deploy_key, admin token  (gitignored,       │
│                        NEVER mounted into any agent)                      │
└──────────────────────────────────────────────────────────────────────────┘
   wildcard:  *.serverdomain.com  A  <server-ip>   (set once)
```

**Correctness points (from the design research):**
1. One shared Caddy is the only host-port binder; per-site projects expose nothing on the host.
2. External net `mdz_edge`; each site's mdz joins it with a **unique alias `mdz-<site>`** (never the shared name `mdz` → avoids cross-tenant routing); Caddy targets `mdz-<site>:3001`.
3. Caddy routes via per-site snippet files + `caddy validate && reload` (not the admin API).
4. Per-host TLS via HTTP-01 (wildcard DNS makes every subdomain resolve; no wildcard cert).
5. **Content vs secrets split:** `sites/<site>/repo` = content only; `secrets/<site>/` = keys/env. This is what lets the single admin agent mount all content (`sites/`) read-write **without** ever seeing deploy keys or `JWT_SECRET`.
6. Agents must run nanoclaw `runtime: "container"` — native mode ignores all mounts/`readonly` (full host FS), so RO/RW segregation only holds in container mode.

## Repo restructure (representative paths)

```
mdz-ai-deploy/
├─ platform/
│  ├─ docker-compose.platform.yml   # shared Caddy; ports 80/443; net mdz_edge (external)
│  └─ caddy/{Caddyfile, sites/.gitkeep}   # global imports sites/*.caddy
├─ compose/
│  ├─ docker-compose.site.yml        # mdz+sidecar; no host ports; mdz alias mdz-${SITE} on mdz_edge;
│  │                                 #   bind-mounts ../sites/${SITE}/repo:/data/repo; injects BACKEND_URL
│  ├─ site.env.example
│  └─ docker-compose.smoke.yml       # KEEP
├─ sites/<site>/repo/                # NEW, gitignored: CONTENT working tree only (shared by mdz+sidecar+agents)
├─ secrets/<site>/                   # NEW, gitignored: .env, deploy_key(+.pub), admin/<site>.token
├─ agents/                           # NEW: agent CLAUDE.md templates (general/admin) + agents.yaml manifest
├─ scripts/                          # NEW: idempotent bash/ts glue for both skills
├─ .claude/skills/{setup,add-mdz-site,add-agent}/SKILL.md   # NEW
├─ docker/Dockerfile.{mdz,sidecar}   # reuse; build mdz:${MDZ_REF} once
└─ .gitignore                        # ADD: sites/, secrets/, platform/caddy/sites/*.caddy (keep .gitkeep)
```
`compose/docker-compose.yml` + `compose/Caddyfile` (single-site) are superseded by the split.

---

## Part A — Serve sites

### `/setup` (once per server)
1. **Docker preflight** — `docker info`; guide install/start; refuse if `:80/:443` already bound (leftover nginx/certbot).
2. **Inputs** — `AskUserQuestion`: base domain, ACME email (+ Telegram bot token & Claude auth for Part B, collected here).
3. **Platform up** — `docker network create mdz_edge` (idempotent), render `platform/caddy/Caddyfile`, `compose -f platform/docker-compose.platform.yml up -d`.
4. **Wildcard DNS** — `detect-public-ip.sh` → show `* A <ip>`; confirm added.
5. **Verify DNS** — `dns-check.sh` polls a fixed probe host vs the IP.
6. **TLS self-test** — drop a throwaway `respond 200` snippet, reload, `curl --fail https://mdz-selftest.<base>` (real cert, no `-k`), remove + reload. Fixed probe hostname to spare LE rate limits.
7. **Deploy nanoclaw** (Part B §B1) and **report**.

### `/add-mdz-site` (per site)
1. **Preflight** — platform up; `AskUserQuestion`: content-repo URL, sitename (validate DNS label = project = alias = snippet name), owner email, branch (default `main`). Idempotency: if `sites/<site>/` exists → reconcile/abort.
2. **Deploy key** — `gen-deploy-key.sh`: ed25519, `chmod 600`, into `secrets/<site>/`; register on GitHub via `gh repo deploy-key add … --allow-write` or manual fallback.
3. **Render env** — `secrets/<site>/.env`: `SITE_NAME`, `BASE_DOMAIN`, `CONTENT_REPO`, `MDZ_REF` (pinned to a commit incl. Phase 2 — now `mdz` main `819bb83`), `PAGES_SUBDIR=pages`, `JWT_SECRET=$(openssl rand -hex 32)`, `DEPLOY_KEY=../secrets/<site>/deploy_key`, `SYNC_EXCLUDE=.auth/,.settings/`.
4. **Clone content** — host `git clone` (deploy key via `GIT_SSH_COMMAND`) into `sites/<site>/repo`; assert `pages/` exists; one-shot `git rm --cached` sweep if `.settings/users.yaml` is already tracked.
5. **Up + health** — `docker compose -p mdz-<site> --env-file secrets/<site>/.env -f compose/docker-compose.site.yml up -d`; `wait-healthy.sh` polls `/api/health`.
6. **Seed owner + magic link** — `docker exec -e BACKEND_URL=https://<domain> mdz-<site> node dist/cli/admin.js add-user <email> admins` (**`node dist/cli/admin.js`, not `npm run admin`** — the image prunes `tsx`; `dist/cli/admin.js` + `js-yaml`/`jsonwebtoken` are present). Prints the magic link.
7. **Route + TLS** — write `platform/caddy/sites/<site>.caddy` (`<domain> { reverse_proxy mdz-<site>:3001 }`); `caddy validate && reload`.
8. **Provision agents** — register the site's general agent and mint its admin token (Part B §B3); **report** URL + admin link.

### Serve gotchas (baked in)
`BACKEND_URL` set or minted links break · never `down -v` the Caddy project (holds certs → LE lockout) · deploy key must exist + be `600` before `up` (else Docker mounts a dir, SSH fails silently) · gitignore `sites/`+`secrets/` · per-site `SYNC_EXCLUDE` keeps member emails off GitHub (consequence: membership is non-synced state → backup item).

### Helper scripts (`scripts/`)
`lib/common.sh` · `platform-up.sh` · `detect-public-ip.sh` · `dns-check.sh` · `tls-selftest.sh` · `caddy-reload.sh` · `gen-deploy-key.sh` · `add-deploy-key-github.sh` · `render-site-env.sh` · `clone-content.sh` · `site-up.sh` · `wait-healthy.sh` · `seed-admin.sh` · `register-route.sh`.

---

## Part B — Agents

### B1. Deploy ONE host nanoclaw (in `/setup`)
- Clone `mynanoclaw` as a sibling; run **its** `/setup` once → installs a **native launchd/systemd service** running `dist/index.js` (the orchestrator can't be containerized — it owns the chat socket, SQLite DB, IPC watcher, scheduler).
- Needs: Claude auth in nanoclaw's `.env` (`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`, one host-wide cred); `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_ONLY=true` for headless); built `nanoclaw-agent:latest` container image; **mount allowlist** `~/.config/nanoclaw/mount-allowlist.json` with the `sites/` root `allowReadWrite:true` and **`nonMainReadOnly:false`** (the shipped template defaults it to `true`, which would force the admin agent read-only). Allowlist is cached for process lifetime → set before first start.
- Drive nanoclaw **by data, not code**: `mdz-ai-deploy` writes only into its seams (`register_group` IPC, `groups/<folder>/CLAUDE.md`, the allowlist). Generalize the fork's hardcoded single-site bits (`IIKO_*`, `ZB_GIT_PAT`, `zbadmin` in `container-runner.ts`/`agent-runner`) so it stays generic.

### B2. Per-site general agent
- **Container** runtime; `additionalMounts`: `sites/<site>/repo/pages → /workspace/extra/pages` **readonly** (mount `/pages` only, not the repo root — keeps `.git` out; `secrets/` is already not under `sites/`). No token, no secret.
- Own chat/JID (one Telegram chat); `requiresTrigger:false` for a dedicated 1:1 chat.
- Instructions: operator-editable at `sites/<site>/repo/.mdz/general.md` (synced, versioned); the agent's nanoclaw `groups/<site>-general/CLAUDE.md` is a thin static pointer ("treat `/workspace/extra/pages/../.mdz/general.md` as your operator instructions").
- Optional hardening: narrowed `allowedTools` (drop `Bash`/`WebFetch`) so it has no HTTP tool even in theory.

### B3. The single server-wide admin agent
- **Container** runtime; one chat/JID; full toolset.
- Mount: `sites/ → /workspace/extra/sites` **read-write** (all sites' content). Safe because `secrets/` is a sibling, never under `sites/` — so the admin can edit any site's pages and any `.mdz/general.md`, but never sees deploy keys / `JWT_SECRET`.
- **"Control users" across sites** via each site's admin API (`/api/admin/*`), authenticated by a **short-lived `admins` session JWT per site** (shape `{email:"agent-admin@<site>", provider:"magic", groups:["admins"]}`). The admin agent never holds the raw `JWT_SECRET`. Tokens are delivered into the admin's own group folder `groups/admin/.mdz/tokens/<site>.token` (mounted only to the admin agent), minted by a **host re-minter** (systemd timer/cron) reading `secrets/<site>/.env`.
- **Adding a site** (`/add-mdz-site` step 8): the admin's `sites/` mount already covers new content (no re-register); just mint the new site's admin token into its folder + register the new general agent. Low coupling.

### B4. Registration mechanics
- Live registration = drop a `register_group` IPC file into `data/ipc/main/tasks/` (the watcher derives `isMain` from the dir name; `register_group` is main-only; this updates the DB **and** the in-memory map live — no restart). DB-direct write only at first-boot bootstrap (needs restart). `containerConfig` carries `runtime`, `additionalMounts` (with `readonly`), `timeout`, and (after the change below) `allowedTools`. `folder` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, not `global`; pass a non-empty `trigger` even when `requiresTrigger:false`.

### B5. `/add-agent` skill + scripts
SKILL phases: preflight (nanoclaw service up, container runtime + image, allowlist correct, `sites/<site>/repo` exists) → inputs (site, role, platform, chat id, trigger, persona) → ensure allowlist → write `groups/<folder>/CLAUDE.md` + seed `sites/<site>/repo/.mdz/general.md` → (admin) mint token → register via IPC → bind channel (reuse nanoclaw `add-telegram`: add bot to chat, get chat id, Group Privacy off) → verify (test message; for admin confirm a `GET /api/admin/*` returns non-404). Scripts: `register-agent.ts`, `write-agent-md.ts`, `ensure-mount-allowlist.ts`, `mint-admin-token.ts` (+ the re-minter timer), `reconcile.ts` (desired-state `agents.yaml` → registry/folders/allowlist/tokens), `remove-agent.ts`, `restart-nanoclaw.sh` (needed only for allowlist changes / DB-direct bootstrap / removals — no live unregister IPC exists).

### B6. Required code changes (small, flagged)
- **nanoclaw — per-agent toolsets** (defense-in-depth): add `allowedTools?: string[]` to `ContainerConfig` (`src/types.ts`) — nests in the JSON `container_config`, so **no `db.ts`/schema change**; thread through `ContainerInput` in `src/container-runner.ts` (native ~:521 & container ~:576) to `container/agent-runner/src/index.ts` (hoist the hardcoded `:437-446` list to `DEFAULT_ALLOWED_TOOLS`, use per-agent when present). Rebuild native `dist`.
- **nanoclaw — generalize** the hardcoded ZB/IIKO single-site bits so the shared install is multi-tenant and `/update`-able. (Optional further: a per-agent secret channel in `containerConfig` to inject the admin token via stdin instead of on-disk in the group folder.)
- **mdz — short-lived admin tokens:** today session tokens are signed with no `expiresIn` (`auth.ts:231,316`; plugin sets none) → they never expire and there's no revocation. Add `expiresIn` (and a tiny host-callable signer that reads `secrets/<site>/.env` and mints the `admins` token) so the re-minter can issue ~45-min tokens.

### B7. Threat model + the single-admin tradeoff
| Guardrail | Enforcement |
|---|---|
| General can't read `JWT_SECRET`/keys | General runtime **must** be container (native bypasses mounts); `secrets/` is never under `sites/` and never mounted; `.env` is also a blocked pattern |
| General can't reach `/api/admin/*` | No token + can't forge (no secret); MDZ guard fail-closed (401/404) |
| General can't escalate via `users.yaml` | RO mount on `/pages` only; a *writable* pages mount would let it rewrite `users.yaml`→self-admin, so keep RO + container. (Note: `users.yaml` lives under pages → general can *read* membership; info-leak, not escalation. Optional: relocate `.settings` out of `PAGES_ROOT` or mount a narrower subtree.) |
| Admin token blast radius | Short-lived per-site `admins` token (not raw `JWT_SECRET`) → forge/persist limited to token TTL on that one site |
| Agent can't self-grant mounts/tools | `register_group` is main-only over IPC; mounts validated vs the external allowlist (never mounted) |

**Single-admin tradeoff (explicit):** one admin agent has rw on **all** sites' content + can administer every site → if it is prompt-injected (e.g. via untrusted page/user content), the blast radius is the whole server, not one site. Mitigations: container isolation; short-lived per-site tokens (no raw secrets); secrets kept out of all mounts; feed the admin minimal untrusted input; optionally don't auto-ingest page content into the admin. Accepted for operational simplicity per the user's decision.

---

## Build order
1. **Part A serve** — split compose, the two serve skills + scripts. **DONE** (see `docs/superpowers/plans/2026-06-29-control-plane-part-a-serve.md`); live multi-site verification is operator-run on the server.
2. **Code changes** — nanoclaw per-agent `allowedTools` + generalization; mdz short-lived admin token. (Prereqs for secure agents.) **DONE** (see docs/superpowers/plans/2026-06-30-control-plane-part-b-agents.md; built against current nanocoai/nanoclaw — the old fork's code-change items were obsolete)
3. **nanoclaw deploy** wired into `/setup`. **DONE** (see docs/superpowers/plans/2026-06-30-control-plane-part-b-agents.md; built against current nanocoai/nanoclaw — the old fork's code-change items were obsolete)
4. **Per-site general agents** via `/add-agent`. **DONE** (see docs/superpowers/plans/2026-06-30-control-plane-part-b-agents.md; built against current nanocoai/nanoclaw — the old fork's code-change items were obsolete)
5. **The one admin agent** (a one-time `/add-agent --role admin` or a `/setup` step) + the token re-minter. **DONE** (see docs/superpowers/plans/2026-06-30-control-plane-part-b-agents.md; built against current nanocoai/nanoclaw — the old fork's code-change items were obsolete)

## Verification
**Serve:** `/setup` → Caddy up, `mdz_edge` exists, TLS self-test 200 on a valid LE chain. `/add-mdz-site demo` → `curl --fail https://demo.<base>/api/health` ok; magic link logs in as `admins`; two-way sync (local edit → `Auto-save` commit on remote; remote push → volume reflects it, remote-wins); `users.yaml` never pushed; add `demo2` → independent certs/content/secrets, no cross-tenant routing.
**Agents:** general agent (its chat) reads a page but a prompt to read `JWT_SECRET` / call `/api/admin/*` fails (no secret, RO mount, container). Admin agent (its chat): "add alice@x to writers on demo" → succeeds via demo's admin API; "update demo2's general agent instructions" → edits `sites/demo2/repo/.mdz/general.md`; the demo2 general agent reflects it on its next fresh session. Confirm the admin sees content but not `secrets/`.
**Early checkpoint:** build `mdz:${MDZ_REF}` and confirm `docker run --rm mdz:<ref> node dist/cli/admin.js list` runs before building skills around it.

## Out of scope / known gaps
`/update-mdz`, `/diagnose`, `/add-user` skills (small, same pattern; `/diagnose` must surface swallowed sidecar push failures) · nanoclaw live `unregister_group` IPC (removals need restart) · one bot identity per host channel (all Telegram agents share a bot username, distinguished by chat) · per-agent secret channel patch (cleaner than on-disk token) · wildcard DNS-01 single cert if churn grows · GitHub host-key pinning (replace TOFU); auth-state backup/restore; `js-yaml` as an explicit `mdz` backend prod dep.
