# Phase 1 — tracked follow-ups

Items deliberately left for later phases, surfaced by the final review of the
data-plane branch. None block Phase 1.

## Handoff to Phase 2 (auth PR in `mdz`)
- **Relocate MDZ auth-state out of the synced tree.** Today MDZ writes
  `${PAGES_ROOT}/.settings/users.yaml` (member email → groups). Phase 1 defends
  this by default-excluding both `.settings/` (current path) and `.auth/`
  (future path) from sync. The Phase-2 auth PR should move auth-state to a
  non-synced location (design §7.2); once it does, `.settings/` content that is
  *not* secret can sync again if desired.
- **Already-tracked secret hardening.** `.git/info/exclude` only affects
  *untracked* files. If a content repo already tracks `.settings/users.yaml`
  from a prior life, exclusion won't help. Add a startup `git rm --cached`
  sweep (or a loud warning) for configured exclude paths that are tracked.

## Phase 3 (control-plane spawn skill)
- **Volume bootstrap is the spawn skill's job.** The compose stack assumes
  `/data/repo` is already a populated working tree; `spawn-site` clones the
  content repo + seeds the admin into the volume before first `up`. (Compose has
  a comment noting the prerequisite; `docs/smoke-test.md` seeds it manually.)
- **Wire `CONTENT_REPO`.** It's currently documentation-only in `.env.example`;
  the spawn skill should consume it for the clone step.
- **Deploy-key ergonomics.** The sidecar mounts `${DEPLOY_KEY}:/keys/deploy_key:ro`.
  If the file is missing, Docker bind-mounts a *directory* and SSH fails
  confusingly; if perms are loose SSH refuses it. spawn-site should generate the
  key, `chmod 600` it, and verify it exists.

## Later / optional
- **Per-person commit attribution.** MVP commits as the site bot; add an
  author-hint channel if per-actor history is wanted (design §12).
- **Webhooks instead of polling** once a public endpoint + shared secret exist.
- **Git-LFS / retention** for heavy binary content repos.
- **Backup/restore of the non-synced auth-state** (the one thing not in git).
- **Host-key pinning** for `github.com` instead of TOFU (`accept-new`).
