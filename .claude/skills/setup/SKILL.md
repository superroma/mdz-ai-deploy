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

**Behind a Cloudflare tunnel?** TLS terminates at the tunnel edge, so run Caddy HTTP-only instead:
```bash
EDGE_MODE=tunnel scripts/platform-up.sh   # no ACME_EMAIL; Caddy serves :80 only
```
In the Cloudflare Zero Trust dashboard add one public hostname `*.<base> → http://localhost:80`
(cloudflared preserves the Host header, so per-site snippets route unchanged). Then **skip steps 4–5**
(DNS is a wildcard CNAME the dashboard manages, not an A record) and go straight to step 6 — the same
`tls-selftest.sh` works, validating DNS → tunnel → Caddy with Cloudflare's edge cert.

## 4. Wildcard DNS (Let's Encrypt mode only)
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
`scripts/deploy-nanoclaw.sh` clones nanoclaw into the **toolkit-owned `./nanoclaw`** (gitignored) — it does not touch any nanoclaw checkout elsewhere. nanoclaw then sets **itself** up via its own Claude Code skills (deps, Claude auth, agent container, service); run them in that checkout:
```bash
scripts/deploy-nanoclaw.sh            # clones ./nanoclaw, prints the hand-off
cd nanoclaw && claude
  # /setup        — dependencies, Claude auth, agent container, service
  # /add-telegram — wire your Telegram bot token (BotFather)
  # /init-onecli  — OneCLI gateway; puts onecli/ncl on PATH
```
Back in this repo, grant agents access to content — `scripts/ensure-mount-allowlist.sh` then restart nanoclaw — and provision agents with `/add-agent`.

## 8. Report
Confirm: platform up, `mdz_edge` exists, DNS resolves, TLS chain valid. The server is ready for `/add-mdz-site`.
