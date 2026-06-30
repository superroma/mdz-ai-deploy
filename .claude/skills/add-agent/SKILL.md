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
