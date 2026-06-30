# Test-deployment handoff — MDZ control plane on a Mac mini

**For:** a fresh Claude Code agent (or operator) running the FIRST real deployment on an empty Mac mini.
**Goal:** bring the control plane up end-to-end on one host and, in doing so, close the integration unknowns that could not be verified in the authoring sandbox.

You are the runner. Read this whole doc once before starting. Work in **stages** — each stage has a verification gate; do not advance past a red gate.

---

## 0. What is already done (so you don't redo it)

All code is written, reviewed, and merged to `main` in two repos (both pushed to `github.com/superroma/...`):

- **`mdz-ai-deploy`** (this repo) — the control plane: `scripts/`, `control/` (TS), `compose/`, `docker/`, and three skills: **`/setup`**, **`/add-mdz-site`**, **`/add-agent`**. Background docs: `docs/control-plane-serve.md` (Part A, serving) and `docs/control-plane-agents.md` (Part B, agents + threat model).
- **`mdz`** (the product) — the site backend. `main` is at **`d153817`**, which includes magic-link auth, the admin membership API/CLI, and (Part B) the `mint-admin-token` CLI + `js-yaml` prod-dep fix.

**Nothing has ever run on a server.** Everything below is statically validated only (`bash -n`, `node --check`, vitest). The whole point of this exercise is the live run.

### Use `MDZ_REF=d153817` everywhere
`d153817` is a strict superset of the old `819bb83` pin — it has everything Part A needs **plus** `mint-admin-token`. The skill examples still show `819bb83`; for this test, **build and pin `d153817`** from the start so a single mdz image works for all stages (the admin path needs `mint-admin-token`, which `819bb83` lacks).

---

## Operating rules (important — these shaped the design)

1. **Zero `nanoclaw` code edits.** nanoclaw (`nanocoai/nanoclaw`) is used **as-is**. If something in nanoclaw is wrong, work around it **in this repo's scripts/config** — never patch nanoclaw. (Two upstream quirks are already worked around: the mount-allowlist field name `allowReadWrite`, and `:ro` enforcement.)
2. **Secrets never enter an agent mount.** Only `sites/<site>/repo` content is ever mounted to an agent. `secrets/<site>/` (deploy keys, `JWT_SECRET`) is a sibling and must never appear in any mount or allowlist root. Re-check this on the box.
3. **Ask the human for secrets** — domain, ACME email, Telegram bot token, Claude/Anthropic auth. Do not invent them. The human runs privileged/interactive logins themselves (suggest they type `! <command>` in-session, e.g. an interactive `claude login`).
4. **When reality differs from a script, fix the script in THIS repo and commit it.** The unknowns below (especially the `onecli` flag shapes) are expected to need real adjustment. That is normal and intended — record what you learned.
5. **Stop at any red gate** and report. A broken foundation makes every later failure ambiguous.

---

## The machine

- Apple-Silicon Mac mini, macOS. Homebrew lives at `/opt/homebrew/bin` (the re-minter's launchd/cron PATH already includes both `/opt/homebrew/bin` and `/usr/local/bin`).
- The re-minter timer uses **launchd** on macOS (`scripts/install-reminter.sh` Darwin branch) — correct for this host.
- **Docker Desktop (or OrbStack/Colima) must be running** before any compose step — `docker info` must succeed.
- Reachability: for the full agent/admin path the sites must be reachable at real hosts `*.<base>` over TLS (magic-link and the OneCLI host-pattern `<site>.<base>` both want real hosts). Decide with the human: a real (even throwaway) domain with **wildcard DNS → the mini**, fronted by a public IP or a tunnel (cloudflared/tailscale). A pure `:80` localhost test (see `compose/.env.example`) can validate Part A serving but will not exercise the admin token injection realistically.

---

## Stage 0 — Prerequisites

```bash
# Tooling (ask before installing; confirm Docker is running)
brew install git node pnpm        # docker via Docker Desktop/OrbStack
docker info                        # must succeed

# Repos under ~/work
mkdir -p ~/work && cd ~/work
git clone git@github.com:superroma/mdz-ai-deploy.git
git clone git@github.com:nanocoai/nanoclaw.git      # the agent host, used as-is
# (mdz is cloned by the Docker build via MDZ_REF; you don't need a working copy unless debugging)
```

Collect from the human now: **base domain**, **ACME email**, **Telegram bot token** (BotFather), **Claude/Anthropic auth** for nanoclaw.

`onecli` and `ncl` are provided by nanoclaw's own setup (Stage 2) — you do not install them separately. Confirm after Stage 2 that both are on `PATH`.

**Gate 0:** `docker info` ok; both repos cloned; secrets collected. ✅

---

## Stage 1 — Foundation (Part A serving). Lowest risk; proves the base.

Invoke the **`/setup`** skill (steps 1–6 only for now): it brings up the shared `mdz-edge-caddy` on the external `mdz_edge` network, sets wildcard DNS, and runs a real-cert TLS self-test. Provide the base domain + ACME email when asked.

Then build the mdz image and add one test site. Invoke **`/add-mdz-site`** with a throwaway content repo. **Set `MDZ_REF=d153817`** when it renders the per-site env (the skill shows `819bb83` — override to `d153817`).

Verify (Gate 1) — all must pass:
- `docker ps` shows `mdz-edge-caddy` and the site's `mdz-<site>` + sidecar healthy.
- `https://<site>.<base>` serves content over a valid cert.
- The magic-link login from `/add-mdz-site` step 7 works (owner can sign in).
- `docker run --rm mdz-app:d153817 node packages/backend/dist/cli/admin.js list` runs (this is the js-yaml prune check) **and** `... mint-admin-token agent-admin@<site>.<base>` prints a JWT. ← proves Phase B-1 in the built image.

If the foundation is red, stop here — do not deploy nanoclaw on a broken base.

---

## Stage 2 — nanoclaw + one general agent (read-only, no secrets)

1. **`/setup` step 7** → `NC_DIR=~/work/nanoclaw TELEGRAM_BOT_TOKEN=<token> scripts/deploy-nanoclaw.sh`. This orchestrates nanoclaw's OWN setup. Follow nanoclaw's interactive steps: install its service, `/init-onecli` (OneCLI gateway + Anthropic cred in the vault), and `add-telegram`. Confirm the nanoclaw service is running and `ncl`/`onecli` are on `PATH`.
2. **Grant content access:** `scripts/ensure-mount-allowlist.sh` then **restart nanoclaw** (the allowlist is cached for the process lifetime — it MUST be written before/with a restart, or the RW mount silently degrades).
3. **`/add-agent` → general:** `NC_DIR=~/work/nanoclaw scripts/register-agent.sh general <site> <base>`, then bind a Telegram chat (skill step 4: `ncl messaging-groups create` + `ncl wirings create`).

Verify (Gate 2):
- Message the general agent's chat: it can read a page from `/workspace/extra/pages/...`.
- It **cannot** read `JWT_SECRET`/deploy keys (they aren't mounted), cannot write a page (RO mount), and has no admin token.
- `ncl groups list` shows the `<site>-general` group with the RO `pages` mount.

---

## Stage 3 — the one admin agent + OneCLI vault + re-minter (highest risk)

Confirm the site's mdz container runs the `d153817` image (Stage 1). Then:

1. **`/add-agent` → admin:** `NC_DIR=~/work/nanoclaw scripts/register-agent.sh admin <base>`. Creates the `admin` group with a **read-write** mount of `sites/` content only (no `secrets/`), and logs the OneCLI/egress steps.
2. **Mint + vault the per-site token:** `scripts/mint-site-admin-secret.sh <site>` — mints inside the `mdz-<site>` container (where that site's `JWT_SECRET` lives) and upserts the secret `mdz-admin-<site>` (host-pattern `<site>.<base>`, header `Authorization: Bearer {value}`) into OneCLI. **← This is where the `onecli` flag shapes get verified for real (see Unknowns).**
3. **Assign to the admin agent ONLY:** `onecli agents set-secrets --id <adminAgentId> --secret-ids <id of mdz-admin-<site>>`. **← Verify the agent-identity mapping here (see Unknowns).**
4. **Egress lockdown:** set `NANOCLAW_EGRESS_LOCKDOWN=true` for the admin agent's container env so the token can't bypass the gateway.
5. **Keep tokens fresh:** `scripts/install-reminter.sh` (launchd, every 30 min; tokens are 45 min).

Verify (Gate 3):
- Message the admin chat: "add `alice@x` to writers on `<site>`" → succeeds via that site's `/api/admin/*` (the gateway injected the token; the agent never saw the raw value).
- The admin **cannot** see `secrets/` (only `sites/` content is mounted).
- After ~30 min, confirm the re-minter refreshed the secret (check `$REPO_ROOT/.reminter.log` / launchd output; the token rotates before its 45-min expiry).

---

## Known unknowns — expect to investigate these live, then fix our scripts

These could not be verified without a running OneCLI/nanoclaw. When the real interface differs, **edit the named script in this repo and commit** (`fix(control): match real onecli/ncl interface — <what>`):

1. **`onecli secrets` flag shapes** — `scripts/mint-site-admin-secret.sh` uses `onecli secrets list|create|update` with `--name/--value/--host-pattern/--header-name/--value-format`, taken from nanoclaw's skill docs. Confirm against the installed version: `onecli secrets --help`, `onecli secrets create --help`. Adjust the script to the real flags.
2. **Agent identity for `set-secrets`** — `/add-agent` assumes the admin agent's OneCLI identity is its **agent-group id**. Confirm with `onecli agents list` / `ncl groups list` and the `onecli agents set-secrets --help` signature. Fix the assignment command (and the skill note) to whatever the real identifier is.
3. **`welcome` skill exists?** — `register-agent.sh` general branch sets `skills '["welcome"]'`. If nanoclaw has no `welcome` skill, the general agent ends up with none — pick a real minimal skill and update the script.
4. **nanoclaw setup specifics** — `deploy-nanoclaw.sh` assumes `pnpm install && pnpm build`, `container/build.sh`, and `setup.sh`/`/init-onecli`/`setup/add-telegram.sh`. If nanoclaw's actual entrypoints differ, adapt the orchestration script (do not patch nanoclaw).
5. **`updateContainerConfigJson` + `ncl groups create` JSON** — already confirmed against nanoclaw source (`src/db/container-configs.ts:83`; `groups create` returns `{"id":...}`). If the deployed build differs, note it.

For each: record the real interface in your final report so the scripts become ground-truth.

---

## Security invariants to re-verify on the box (non-negotiable)

- No mount path (general or admin) is under `secrets/`. Check the written `~/.config/nanoclaw/mount-allowlist.json` roots and each group's `additional_mounts`.
- The minted token is never written to disk outside the OneCLI vault and never logged (`mint-site-admin-secret.sh` logs only the secret name + host).
- Egress lockdown is on for the admin agent.
- The general agent holds no secrets and is read-only.

---

## When you're done

1. Commit any script fixes you made to match the real `onecli`/`ncl`/nanoclaw interfaces (NOT nanoclaw itself), with clear messages, and push.
2. Write a short **deployment report** back to the human: which gates passed, the exact `onecli`/`ncl` interfaces you confirmed, any workarounds added, and what (if anything) is still red.
3. If a gate is blocked on a human decision (domain/DNS/secrets) or a genuine nanoclaw limitation, stop and surface it — don't force it.

## Pointers
- Architecture / threat model: `docs/control-plane-agents.md`, `docs/control-plane-serve.md`.
- Full Part B plan (rationale, constraints, the integration-unknown call-outs): `docs/superpowers/plans/2026-06-30-control-plane-part-b-agents.md`.
- Skills are the executable source of truth: `.claude/skills/{setup,add-mdz-site,add-agent}/SKILL.md`.
