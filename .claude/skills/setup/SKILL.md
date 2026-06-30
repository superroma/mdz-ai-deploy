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
- **Telegram bot token + Claude auth** — for the host nanoclaw (used in step 7).

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

## 7. Deploy the host nanoclaw (agents)
Collect the Telegram bot token + Claude auth (step 2). Then:
`NC_DIR=~/work/nanoclaw TELEGRAM_BOT_TOKEN=<token> scripts/deploy-nanoclaw.sh`
Follow nanoclaw's own setup (service install, `/init-onecli`, add-telegram). Then grant agents access to content:
`scripts/ensure-mount-allowlist.sh` and restart nanoclaw. Provision agents with `/add-agent`.

## 8. Report
Confirm: platform up, `mdz_edge` exists, DNS resolves, TLS chain valid. The server is ready for `/add-mdz-site`.
