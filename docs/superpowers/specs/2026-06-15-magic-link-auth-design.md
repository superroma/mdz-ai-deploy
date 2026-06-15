# Magic-Link Auth — Design Spec (Plan 2)

- **Date:** 2026-06-15
- **Status:** Approved (brainstorm complete) — ready for implementation plan
- **Author:** Roman Eremin (with Claude)
- **Target repo:** `mdz` — a focused, additive PR on branch `magic-link-auth`
- **Parent design:** `2026-06-14-mdz-ai-deploy-design.md` §7.2. This spec refines it and **deliberately diverges** from it — see §8.

## 1. Goal

Add a magic-link login path to MDZ so an admin can onboard a member with a single link — without OAuth client-ID setup and without MDZ sending email. The PR is **purely additive**: it reuses MDZ's existing JWT/session, group resolution, and `users.yaml` membership, and changes **none** of MDZ's storage or config conventions.

## 2. Scope decisions (settled in brainstorming)

- **Admin/nanoclaw-mediated delivery.** MDZ mints links and *returns* them via an admin API; MDZ never sends email/SMTP. Delivery is out-of-band (admin shows the link, or nanoclaw sends it over the member's channel).
- **Magic-links only, identity-bound.** Every link is bound to a known email at mint time. No shareable / identity-unbound invites in this PR (`mintInvite` deferred). No public "enter your email" page.
- **Stateless, replayable, short-TTL.** A magic-link is a short-lived signed JWT (reusing `JWT_SECRET`), replayable within its TTL, then dead. **No** server-side token store, **no** new persisted state, **no** new files, **no** new dependencies.
- **MDZ storage unchanged.** Membership stays at `pages/.settings/users.yaml`. No relocation, no `MDZ_AUTH_DIR`. Membership-in-git is *deliberate, versioned config* (the content repo is private and repo access already implies admin) — **not a leak**, the same category as the `__access` group names already stored in page front-matter. Leak-prevention, if ever wanted, is the sync-sidecar's job (data plane), never MDZ's.

## 3. Two lifetimes (important)

- **Magic-link TTL** — the URL token. A few hours, configurable (`MAGIC_LINK_TTL`, default ~2h). Long enough to click after mediated delivery. Because the token is stateless/replayable, the TTL **is** the replay window — keep it to hours, not days.
- **Session** — issued on click. MDZ's normal long-lived session, identical to an OAuth login: the frontend stores it in `localStorage` via `/auth/callback?token=`. After one click the member returns **without** the link, indefinitely, until they log out / clear storage / change device. There is **no self-serve re-login** — a new session then needs a fresh admin-minted link (`mintMagicLink`).

The magic-link is thus a **one-time bootstrap into a normal persistent session**.

## 4. Components

### 4.1 Magic-link token
A signed JWT with claims `{ email, purpose: "magic-link", exp }`, signed with the existing `JWT_SECRET` via `@fastify/jwt`. It carries **no** `groups` — it grants nothing on its own and must be exchanged at the verify endpoint. `exp = now + MAGIC_LINK_TTL`.

### 4.2 Verify endpoint (public, deterministic, no LLM)
`GET /api/auth/magic?token=…`:
1. `app.jwt.verify(token)` — reject invalid/expired → `302 /login?error=expired-link`.
2. Assert `purpose === "magic-link"` (rejects a session token replayed here).
3. Resolve groups: `calculateUserGroups(email, loadUsersConfig())`. If empty → reject (`NO_ACCESS`, existing pattern) → `/login?error=no-access`.
4. Sign the **session** JWT `{ email, firstName?, lastName?, avatar?, provider: "magic", groups }`.
5. Set the `auth_token` cookie (same options as the OAuth callback) and `302 → /auth/callback?token=…`.

This mirrors the tail of the existing OAuth callback in `packages/backend/src/routes/auth.ts`.

### 4.3 Session-verify hook hardening
The existing session-verify hook (`packages/backend/src/mdz-server.ts`) must reject tokens whose `purpose === "magic-link"`, so a raw magic-link JWT can't be used directly as a session cookie/Bearer. (It already carries no groups and would fail access anyway; this is defense-in-depth plus a clear 401.)

### 4.4 Admin API (`/api/admin/*`, `admins`-guarded)
A new admin guard hook: require `currentUser.groups` to include `admins`, else **404** (fail-closed, matching the page routes' info-leak avoidance). Endpoints (spec name in parens):
- `POST /api/admin/users` `{ email, groups }` → upsert into `users.yaml`, mint & return `{ magicLinkUrl }`  *(addUser)*
- `POST /api/admin/users/:email/magic-link` → mint & return a fresh link for an existing member  *(mintMagicLink — the "returning login" path)*
- `PUT /api/admin/users/:email` `{ groups }` → update groups in `users.yaml`  *(setGroups)*
- `DELETE /api/admin/users/:email` → remove from `users.yaml`  *(removeUser)*
- `GET /api/admin/users` → list membership  *(listUsers)*

These introduce a **write** path to `users.yaml` (today it is read-only). Writes preserve the existing schema (`defaultAccess` + `users: { email: { groups } }`), are **serialized** to avoid concurrent-write races, and re-serialize via `js-yaml` so the file stays human-editable.

Revocation is free: because groups resolve from `users.yaml` at verify time, `removeUser`/`setGroups` instantly affect any already-delivered link.

The base URL used to render `magicLinkUrl` reuses the existing `BACKEND_URL` / frontend-origin convention already used for OAuth callbacks.

### 4.5 CLI fallback
A tiny backend script (`npm run admin -- <cmd>`): `add-user <email> <groups…>`, `set-groups`, `remove`, `list`, `mint-link <email>`. Wraps the same membership module + token minting so a host admin can onboard without nanoclaw (§7.2 "no-nanoclaw fallback").

### 4.6 Frontend
Essentially untouched — verify reuses `/auth/callback?token=`. Only addition: handle `?error=expired-link` on the login page (alongside the existing `no-access` / `invalid-login`). Magic-link is **not** added to `/api/auth/providers` (no public initiation).

## 5. Data flows

- **Onboard:** admin → `addUser(alice@x, [writers])` → membership written + magic-link minted → admin/nanoclaw delivers link → Alice clicks → verify resolves `[everyone, writers]` → session issued → Alice editing.
- **Returning login (after session loss):** admin → `mintMagicLink(alice@x)` → deliver → click → new session.
- **Revoke:** admin → `removeUser(alice@x)` → membership gone → any outstanding link resolves to no groups → rejected.

## 6. Security

- Stateless replay window = TTL → keep TTL to hours; rely on mediated delivery over a trusted channel.
- `purpose` claim isolates magic-link tokens from session tokens (both directions).
- Admin routes fail-closed (404 without `admins`).
- A magic-link token grants nothing without exchange (no groups inside it).
- No new secret-at-rest: tokens are never stored; `JWT_SECRET` already exists.
- `users.yaml` writes are schema-preserving and serialized.

## 7. Testing

- **Vitest (backend):**
  - mint → verify happy path issues a correct session with resolved groups
  - expired token → rejected; tampered/invalid signature → rejected
  - `purpose` mismatch both directions (session token at verify endpoint; magic token at session hook) → rejected
  - admin guard: non-admin → 404; admin → 200 for each op
  - `addUser` / `setGroups` / `removeUser` / `listUsers` mutate a temp `users.yaml` correctly and preserve schema
  - a removed user's previously-minted link → rejected at verify
- **E2E (Playwright/Cucumber):** mint via admin API → visit link → authenticated with expected groups; expired link → error page. Mirrors `packages/e2e/features/authentication.feature`.

## 8. Divergences from parent spec §7.2 (conscious)

| §7.2 said | This PR |
|---|---|
| Relocate auth-state outside the synced tree | **No relocation**; `users.yaml` stays in `pages/.settings/` (private repo → not a leak) |
| Invite tokens (max-uses, expiry) **and** magic-links | **Magic-links only**, identity-bound; `mintInvite` deferred |
| "magic-link delivered" (implying possible email) | **No email/SMTP**; admin-mediated *return* of the link only |
| Single-use magic-links | **Stateless, replayable within a short TTL** (no token store) |

## 9. Out of scope (deferred)

Shareable / identity-unbound invites; email/SMTP delivery; public self-serve login or invite-accept pages; hard single-use tokens; auth-state relocation; per-person commit attribution. Each can be added later without reworking this PR.
