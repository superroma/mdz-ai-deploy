---
name: add-agent
description: Provision an MDZ agent on the host nanoclaw — a per-site read-only "general" agent, or the one-time server-wide read-write "admin" agent. Requires /setup (incl. nanoclaw deploy) to have run.
---

# /add-agent — provision a site general agent or the one admin agent

Run from the `mdz-ai-deploy` repo root on a server where `/setup` deployed nanoclaw. Uses the toolkit-owned checkout `./nanoclaw` (override with `NC_DIR` only to point at a different one).

**`/add-agent` needs a `role`.** Establish it before anything else — this is the first thing to resolve when the skill is invoked bare.

## 1. Role + inputs (AskUserQuestion) — do this FIRST
Take the role from the invocation if given (e.g. `/add-agent general <site>`); otherwise ask:
- **Role**: `general` (a read-only agent for ONE existing site) or `admin` (the one-time, server-wide read-write agent).
- For `general`: **site name** (DNS label — an existing `/add-mdz-site` site) and **base domain**.
- **Telegram chat id** for this agent's dedicated chat.

## 2. Preflight (once the role is known)
**Hard prerequisite: `/setup` must have deployed nanoclaw on THIS host (through step 7).** `register-agent.sh` calls `require_nanoclaw` and exits immediately with an actionable message if `ncl` isn't on PATH. If that fires, **`/setup` is not finished — run its nanoclaw-deploy step and retry.** Do **not** go searching other folders for a nanoclaw runtime; a missing `ncl` means it was never deployed here, full stop.

Also confirm:
- OneCLI gateway up; agent image built.
- `scripts/ensure-mount-allowlist.sh` has been run (grants RW on `sites/` via `allowReadWrite`) and nanoclaw was restarted after (the allowlist is cached for the process lifetime).
- **general** → `sites/<site>/repo/pages` exists (the site was added via `/add-mdz-site`).
- **admin** → the `mdz` image running each site includes Phase B-1's `mint-admin-token` (rebuild `mdz-app` at an `mdz` ref that includes it and re-pin the site's `MDZ_REF` via `render-site-env`). Verify: `docker compose -p mdz-<site> exec -T mdz node packages/backend/dist/cli/admin.js mint-admin-token agent-admin@<site>.<base>` prints a JWT before installing the re-minter.

## 3a. General agent
```bash
scripts/register-agent.sh general <site> <base>   # prints the group id
```
Creates the group, sets a minimal skill set + a **read-only** `pages/` mount at `/workspace/extra/pages`, writes `groups/<site>-general/CLAUDE.local.md` (a thin pointer to the synced `pages/.mdz/general.md`), seeds that file, and restarts. No secrets are assigned — the general agent holds none.

## 3b. Admin agent (one-time)
```bash
scripts/register-agent.sh admin <base>           # prints the group id
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
