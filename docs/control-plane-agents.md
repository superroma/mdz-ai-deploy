# Control plane — agents (Part B)

Every site gets a read-only **general** agent over its pages; the server has **one** read-write **admin** agent over all sites' content. One host nanoclaw (`nanocoai/nanoclaw`, used as-is) runs them all.

## Model
- General agent (per site): container, RO mount of `sites/<site>/repo/pages` → `/workspace/extra/pages`, no secrets, own chat. Instructions: `sites/<site>/repo/pages/.mdz/general.md` (synced).
- Admin agent (one): container, RW mount of `sites/` → `/workspace/extra/sites` (content only — `secrets/` never mounted). Calls each site's `/api/admin/*` using a short-lived per-site `admins` token injected by the **OneCLI vault** (`mdz-admin-<site>`, host `<site>.<base>`). Egress lockdown on.

## Pieces
- `mdz`: `mint-admin-token` CLI mints a 45m `admins` session JWT (signed with that site's JWT_SECRET).
- Re-minter (`scripts/reminter.sh`, every 30m): refreshes each site's vault secret.
- Provisioning: `/add-agent` → `ncl groups/messaging-groups/wirings` + `scripts/nc-set-container-json.sh` for `skills`/`additional_mounts`.

## Workarounds (nanoclaw used as-is)
- Mount allowlist is written directly with `allowReadWrite` (upstream `/manage-mounts` writes the wrong field name).
- General-agent tool-narrowing (drop Bash/WebFetch) would need an upstream change → not done; the boundary is container + RO + no-secrets.

## Tradeoff
One admin agent has RW on all sites + can administer every site → if prompt-injected, blast radius is the whole server. Accepted for operational simplicity; mitigated by container isolation, short-lived per-site tokens (no raw secrets), secrets kept out of all mounts, and egress lockdown.
