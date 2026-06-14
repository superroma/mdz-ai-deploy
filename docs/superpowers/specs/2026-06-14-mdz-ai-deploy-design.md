# MDZ AI Deploy — Design Spec

- **Date:** 2026-06-14
- **Status:** Draft (awaiting review)
- **Author:** Roman Eremin (with Claude)
- **Repo:** `mdz-ai-deploy` (`git@github.com:superroma/mdz-ai-deploy.git`)

## 1. North star

Generalize the hand-built `zb-mdz` deployment into a **repeatable, skill-driven spawner** that stands up collaborative [MDZ](https://github.com/superroma/mdz) sites, each bound to a GitHub **content repo** (e.g. [`bridge-home`](https://github.com/superroma/bridge-home)). Each site is a small Docker Compose project on a VPS, gives a few people a shared knowledge base with **magic-link invite access**, and runs **nanoclaw agents** over the same content.

Guiding principle, which shapes everything below:

> **Skills for the control plane. Code for the data plane.**

The toolkit is not a pile of bash; it is **nanoclaw skills + templates + thin deterministic glue**. A guided menu (integrated into nanoclaw) walks the admin through setup and ops. But the always-running, security/perf-critical pieces stay as plain deterministic code with **no LLM in the loop**.

## 2. Background

- **MDZ** is a pure, filesystem-backed Markdown editor (Fastify backend + React/Vite frontend). It reads/writes pages under a configurable `PAGES_ROOT`, with smart folderization, YAML front-matter, MDX view components, JWT sessions, group-based access control, and per-page `__access`. It must **stay focused** on being that editor.
- **`zb-mdz`** is the existing, production, single-tenant deployment (serves `mdz.zebitlz.pub`, a Notion replacement for a pub/household). It already proves the core ideas, by hand:
  - `deploy.sh` runs from root cron every 5 min and performs **two-way git sync**: auto-commit `zbpages/` changes, `git fetch`, `git merge origin/main --strategy-option=theirs` (else `reset --hard origin/main`), push. The git log is full of `Auto-save zbpages changes …` commits.
  - systemd service + nginx + certbot, OAuth (Google/Yandex), with secrets **hardcoded in `start.sh`** (committed — a leak we fix).
  - A `.CLAUDE.md` already lives inside the pages: Claude is already pointed at this content, ad hoc.
- **`bridge-home`** is a clean example of a **content repo**: just a `pages/` tree (README.md files, nested folders, photos, PDFs/DOCX/DWG attachments). This is the shape every site's content repo takes.

`mdz-ai-deploy` is `zb-mdz` generalized: stop hardcoding one server/domain/pages-dir, turn the `deploy.sh` cron into a proper sidecar, replace the manual setup scripts with skills, and add invite + agent glue.

## 3. Goals / non-goals

**Goals (MVP):**
- Spawn a collaborative MDZ site from a GitHub content-repo URL with a guided, skill-driven flow.
- Two-way git sync between the running site and GitHub (GitHub canonical).
- Magic-link invite access; admin manages users by commanding nanoclaw.
- nanoclaw agents over the content, with rights defined by container mount + toolset.
- Multiple sites on one VPS behind a shared auto-TLS proxy.
- MDZ stays a pure editor; only a focused magic-link/invite PR lands in it.

**Non-goals (explicitly out for MVP — see §10):** GitHub webhooks, Git-LFS, per-person commit attribution, a self-serve web control panel, single-instance multi-root, monitoring/Grafana/IoT, conflict-resolution UI.

## 4. Key decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Git-backed, two-way.** GitHub is the canonical source of truth. | Free history/backup/PRs; content usable outside the app; matches `zb-mdz` today. |
| 2 | **One instance per content repo.** A site = one Compose project. | Strong isolation; fits agents-as-containers; "spawn" = parametrized deploy. |
| 3 | **Magic-link auth via a focused PR into MDZ**, reusing MDZ's JWT + groups + per-page access. Invite/membership/admin API also in MDZ. | Self-hostable (no OAuth client-ID hoops); keeps the security core in one place; magic-link completes MDZ's existing auth story. |
| 4 | **Agents = containers; mount (subtree, ro/rw) + toolset = rights.** Groups are reusable bundles. `admins` default. | Capability-based security enforced by the OS, not app logic; one access vocabulary for humans and agents. |
| 5 | **Docker Compose on a VPS; one shared Caddy edge proxy** (auto-TLS) routes `domain → site`. | Self-hostable, no vendor lock-in; replaces hand-run nginx+certbot+systemd; solves the single-443 problem for multi-site. |
| 6 | **Dumb sync-sidecar** (bot commits), **remote-wins** conflict policy, **poll-pull**. | Already proven by `deploy.sh`; MDZ stays untouched on the storage path; local = workspace, a GitHub push is a deliberate authoritative act that should win. |
| 7 | **Three-repo topology:** `mdz` (app), `mdz-ai-deploy` (host toolkit), content repos (per site). | Keeps MDZ focused; data separate from tooling. |
| 8 | **Skills for the control plane, code for the data plane.** Control plane integrated into nanoclaw's menu. | Reuses nanoclaw's runner/menu; reasoning where it helps (setup/ops); determinism where it must (sync/auth). |

## 5. Repo topology

| Repo | Role | Form | Changes |
|------|------|------|---------|
| **`mdz`** | The app — pure filesystem Markdown editor | TS monorepo (existing) | One focused PR: magic-link provider + invite/membership/admin API |
| **`mdz-ai-deploy`** (this repo) | Host toolkit / control plane | **nanoclaw skills + templates + thin deterministic glue** (Compose template, Caddy config, sync-sidecar) | The new work |
| **content repos** (`bridge-home`, future pages-only `zbpages`, …) | Per-site user data | `pages/` tree only | User-owned |

### 5.1 The `mdz` ↔ `mdz-ai-deploy` contract

The toolkit integrates with MDZ through a small, stable contract — **not** by reaching into MDZ internals:

- **Shared `JWT_SECRET`** and **JWT claim shape** (`email`, optional name, `groups`, `provider`).
- **Auth-state location** (magic-link tokens, invites, `email→group` map) configured to a path **outside the synced content tree** so the sidecar never pushes it.
- **MDZ admin API** (admin-group only): `mintInvite`, `addUser`, `setGroups`, `removeUser`, `listUsers` — called by nanoclaw's admin agent.
- **`PAGES_ROOT`** pointed at the content repo's `pages/` inside the shared volume.

## 6. Architecture

### 6.1 Control plane vs data plane (hard rule)

- **Control plane — skill-driven** (Claude in the loop, low-frequency, reasoning helps): spawn a site, onboard, add/remove a user, add a scoped agent, update MDZ, diagnose, deliver invite links. Integrated into the host nanoclaw menu.
- **Data plane — deterministic code, no LLM in the loop** (24/7, security/perf-critical): MDZ, the sync-sidecar, Caddy, the running agent containers, magic-link verification. Skills *generate and wire* these but never sit inside the git-sync loop or the auth path.

### 6.2 Host layout (one VPS)

```
┌──────────────────────────── VPS ────────────────────────────┐
│  host nanoclaw  ── CONTROL PLANE (skills + menu) ───────────  │
│   • spawn / onboard / add-user / add-agent / update / diag    │
│   • admin agent → calls MDZ admin API; delivers links         │
│                                                               │
│  Caddy (shared edge proxy, auto-TLS)  ── routes domain→site   │
│        │                    │                                 │
│   ┌────┴─────── site A ─────┴───┐   ┌──── site B ────┐        │
│   │ mdz  sync-sidecar  agent(s) │   │  …same shape…   │  ...   │
│   │ shared volume /data/repo    │   │                 │        │
│   └─────────────────────────────┘   └─────────────────┘       │
└───────────────────────────────────────────────────────────────┘
        │ push/pull                         │ push/pull
   GitHub content repo A              GitHub content repo B
```

### 6.3 One site (Compose project)

```
   GitHub repo  ◀──push/pull──▶  ┌──────────────┐
   (canonical)                   │ sync-sidecar │ watch+debounce→commit→push;
                                 │   (git)      │ poll→fetch→merge(theirs)
                                 └──────┬───────┘
                                        │ shared volume: /data/repo
        browser ──▶ Caddy ──▶ ┌─────────┴────────┐
                              │ mdz (untouched   │  PAGES_ROOT=/data/repo/pages
                              │ storage path)    │  reads auth-state from a
                              └─────────┬────────┘  NON-synced path
                                        │ scoped mounts (ro/rw subtree)
                              ┌─────────┴────────┐
                              │ nanoclaw agent(s)│  mount + toolset = rights
                              └──────────────────┘
```

## 7. Component specs

### 7.1 sync-sidecar (data plane, deterministic)

Generalization of `zb-mdz`'s `deploy.sh` git logic into a small long-running container.

- **Outbound:** watches `/data/repo` with a debounce (~5s, matching MDZ autosave). On settle: stage, commit as the site bot, push. A single in-process lock serializes commit vs. pull.
- **Inbound:** **polls** `git fetch` every 30–60s. If remote advanced, merge into the working tree. MDZ reads fresh from disk per request; agents see changes on next read.
- **Conflict policy: remote wins.** `git merge origin/<branch> --strategy-option=theirs --no-edit`; on failure `git merge --abort` then `git reset --hard origin/<branch>`. Local app is the everyday workspace; a GitHub push is a deliberate authoritative act.
- **Exclusions:** the sidecar's ignore-list excludes MDZ's auth-state path (tokens, invites, `email→group`) so secrets/emails never reach GitHub. Page content and access *policy* (group names in front-matter) stay versioned.
- **Identity:** commits authored by the site bot (no per-person attribution in MVP; recoverable later via an author hint without disturbing this design).
- **Git auth:** a per-site deploy key with write access to the content repo.
- **Large files:** binaries (`.pdf/.dwg/.rar/…`) sync as normal git blobs; **no Git-LFS** in MVP (known limitation: repo can grow).

### 7.2 Auth, invites, membership (focused PR in `mdz`)

Keep all of MDZ's existing authorization; add only the front door + a thin admin layer.

- **Magic-link provider:** alongside OAuth. On verified click, issue MDZ's existing JWT shape. Reuses the frontend's `/auth/callback?token=…` convention.
- **Two server-side token types (never committed):**
  - **Invite** — minted by an admin: target group(s), expiry, max-uses. Rendered as a link.
  - **Magic-link** — single-use, short expiry, bound to an identity (email *or* channel id). Possession = proof; clicking establishes the web session.
- **Membership store** — `email/id → groups`, pending invites, live tokens. Today's `users.yaml`, **relocated outside the synced tree** (fixing the current `zbpages/.settings/users.yaml` push). MDZ reads it; the sidecar excludes it.
- **Admin API (admin-group only):** `mintInvite`, `addUser`, `setGroups`, `removeUser`, `listUsers`. Reachable also via a tiny CLI / direct file edit as the no-nanoclaw fallback.
- **Flows:**
  - *Add user:* admin tells nanoclaw "add alice@x / @alice_tg to writers" → admin agent calls `addUser` → MDZ records membership + mints link → nanoclaw delivers it via the matching channel, or shows it to the admin.
  - *Accept invite:* click → enter identity → magic-link delivered → click → verified, JWT issued.
  - *Returning login:* enter identity → if member, magic-link → click → JWT. Non-member → rejected.
  - *Revoke:* admin removes the identity; its tokens die.
- **Bootstrap:** spawn config seeds the owner's email into `admins`, so the spawner is admin on first login.
- **Identity generalization:** email is just one delivery channel; nanoclaw can deliver the link over Telegram/WhatsApp/etc. The link is the credential.

### 7.3 Agents & groups (capability model)

- An **agent** = a nanoclaw container with (a) the repo mounted at a **subtree, ro or rw**, and (b) a **toolset**. Those two things *are* its permissions, enforced by the container — it cannot touch unmounted paths or act beyond its tools.
- A **group** is the reusable bundle that maps to a mount-spec + toolset:
  - `admins` (default): full `rw` mount + full toolset incl. the admin-API tool.
  - e.g. `research-bot`: `ro` on `/`, `rw` on `/research/raw`, tools = read + write-files only.
- **Spawning an agent** = instantiate a group as a container: the toolkit translates the group's mount-spec + toolset into Compose volume mounts + tool config. Adding a narrow bot is config, not code.
- **Two enforcement points, one vocabulary:** humans enforced at MDZ's API layer (per-page `__access`); agents enforced at the container mount layer. Same group names.

### 7.4 nanoclaw control plane (skills + menu, integrated)

`mdz-ai-deploy` ships its control plane as **nanoclaw skills** so the single host-level nanoclaw menu manages both the AI assistant and site ops. Representative skills:

- **spawn-site** — guided: ask for content-repo URL, domain, owner email; provision deploy key; render Compose + Caddy stanza; clone repo; seed admin; bring up.
- **add-user / add-agent / remove-user** — call MDZ admin API / write agent config and (re)launch the container; deliver links.
- **update-mdz** — pull the new MDZ image; `compose up -d`.
- **diagnose** — inspect container/sidecar/proxy state and logs; explain failures.

Skills produce and wire the data plane; they never run inside its hot loops.

### 7.5 Edge proxy & TLS

One shared **Caddy** container terminates 80/443 and routes by hostname to each site's internal MDZ (automatic Let's Encrypt). Adding a site = one Caddy stanza (managed by the spawn skill). Replaces `zb-mdz`'s manual nginx + certbot.

### 7.6 Spawning a site — what it generates

Per-site declaration (collected by the spawn skill, persisted as a small config): content-repo URL, domain, owner email, deploy key, branch, agent list (≥ the admin agent), generated `JWT_SECRET`. The skill then renders a Compose project (mdz + sync-sidecar + agent containers + shared `/data/repo` volume), adds a Caddy route, clones the content repo, seeds the admin, and brings it up.

## 8. Data-flow walkthroughs

- **Human edits a page:** browser → MDZ writes file on `/data/repo` → sidecar debounces, commits (bot), pushes. Others pull on next sidecar cycle / read fresh.
- **Agent edits content:** agent container writes to its `rw` mounted subtree → same sidecar path commits & pushes. No special handling.
- **GitHub push by an authority:** sidecar `fetch` finds remote ahead → merge `theirs` (remote wins) → MDZ/agents see it on next read.
- **Admin adds a user:** admin → nanoclaw command → admin agent → MDZ `addUser` + `mintInvite` → nanoclaw delivers link → invitee clicks → magic-link → JWT session with assigned groups.
- **Spawn a site:** admin → nanoclaw `spawn-site` skill → config collected → Compose + Caddy rendered → repo cloned, admin seeded, containers up → site live at its domain with TLS.

## 9. Security considerations

- **Secrets never in git:** auth-state path excluded by the sidecar; per-site `JWT_SECRET` and OAuth/channel secrets in non-committed env (fixes `zb-mdz`'s committed secrets).
- **Deploy key scope:** one key per site, write-limited to that content repo.
- **Capability isolation:** agent rights are container mounts + toolsets; an agent cannot exceed them regardless of prompt.
- **No LLM in critical loops:** git-sync and magic-link verification are deterministic code.
- **Remote-wins implies GitHub is canonical:** acceptable because local edits are low-stakes/high-frequency and GitHub pushes are deliberate; documented so users treat GitHub as the backup of record.
- **Token hygiene:** magic-links single-use, short expiry; invites expiring + max-use.

## 10. MVP scope

**In:** one content repo → one site on a VPS; sync-sidecar (poll-pull, watch-commit-push, remote-wins, excludes auth-state); magic-link + invite/admin API (MDZ PR); nanoclaw admin agent that adds users & delivers links, plus declaring extra scoped agents; spawn/add-user/add-agent/update/diagnose skills integrated into nanoclaw; shared Caddy auto-TLS proxy; seeded admin.

**Out (YAGNI / later):** GitHub push-webhooks (polling suffices); Git-LFS/large-file handling; per-person commit attribution; self-serve web control panel; single-instance multi-root; monitoring/Grafana/IoT (ZB-specific); conflict-resolution UI; CI/CD beyond an image bump.

## 11. Suggested build order (phases)

Each phase is independently testable; the implementation plan can take them in order.

1. **Data plane bones:** Compose template (mdz + shared volume) + sync-sidecar (watch/commit/push, poll/fetch/merge-theirs, exclusions) + shared Caddy. Validate two-way sync against a test content repo, no auth changes.
2. **Auth PR in `mdz`:** magic-link provider + membership store relocation + admin API; tiny CLI fallback. Validate invite → magic-link → session with groups.
3. **Control-plane skills (nanoclaw):** `spawn-site`, `add-user`, `update-mdz`, `diagnose` integrated into the menu. Validate end-to-end spawn of a fresh site.
4. **Agents:** group → mount+toolset → agent container; admin agent calls the admin API and delivers links; one scoped example agent. Validate capability boundaries.

## 12. Open questions / future

- **Per-site vs. shared agent runtime:** MVP assumes one host nanoclaw spawning per-site agent containers; revisit if isolation needs grow.
- **Per-person commit attribution:** add an author-hint channel later if history granularity matters.
- **Webhooks** to replace polling once a public endpoint + secret are acceptable.
- **Git-LFS / retention** for heavy binary content repos.
- **Backup/restore** of the non-synced auth-state (it's the one thing not in git).
