---
name: add-mdz-site
description: Stand up one MDZ site from a GitHub content repo — deploy key, per-site secrets, content clone, mdz+sidecar up, owner seed + magic link, and Caddy route. Requires /setup to have run.
---

# /add-mdz-site — add one site

Run from the `mdz-ai-deploy` repo root on a server already bootstrapped by `/setup`. Idempotent per site.

## 1. Preflight
- Shared platform up: `docker compose -p mdz-edge-caddy ps` shows Caddy running. If not, run `/setup`.

## 2. Inputs (AskUserQuestion)
- **Content repo** SSH URL (`git@github.com:owner/repo.git`) — the `owner/repo` slug is derived from it.
- **Site name** — a DNS label (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`); becomes the subdomain, compose project, and Caddy snippet name.
- **Owner email** (seeded into `admins`).
- **Branch** (default `main`).
- **Base domain** — the value chosen in `/setup`.

If `sites/<site>/` or `secrets/<site>/` already exists, reconcile (re-run the steps below) rather than duplicating.

## 3. Deploy key + GitHub registration
```bash
scripts/gen-deploy-key.sh <site>
scripts/add-deploy-key-github.sh <site> <content_repo>   # derives owner/repo from the URL; or add secrets/<site>/deploy_key.pub manually (write access)
```

## 4. Render per-site env
```bash
scripts/render-site-env.sh <site> <base> <content_repo> main <branch>
```
> `main` builds the latest `mdz` (which already includes Part B's `mint-admin-token`). Pass a specific commit SHA instead of `main` for a reproducible build. To upgrade an existing site later, re-render with the new ref and re-run `site-up.sh` (it rebuilds the image).

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

> Caution: never `docker compose -p mdz-edge-caddy down -v` — that wipes the shared Let's Encrypt certs/account and risks an ACME rate-limit lockout.

## 9. Verify + report
```bash
curl --fail https://<site>.<base>/api/health     # {"status":"ok",...}
```
Report the site URL + the owner magic link.

## 10. Provision agents (Part B)
Give the new site a general agent and extend the admin agent:
`NC_DIR=~/work/nanoclaw scripts/register-agent.sh general <site> <base>` (then bind a chat),
and `scripts/mint-site-admin-secret.sh <site>` + assign `mdz-admin-<site>` to the existing admin agent. See `/add-agent`.
