# Control plane — serving sites (Part A)

Multi-tenant MDZ hosting on one VPS: a shared Caddy edge plus one compose project
per site. Two operator skills drive it.

## Layout
- `platform/` — shared Caddy (project `mdz-edge-caddy`), the only host-port binder; external network `mdz_edge`; routes via `platform/caddy/sites/*.caddy`.
- `compose/docker-compose.site.yml` — one site (mdz + sidecar), no host ports, mdz alias `mdz-<site>` on `mdz_edge`.
- `sites/<site>/repo` — content working tree (bind-mounted to mdz + sidecar). Gitignored.
- `secrets/<site>/` — deploy key + `.env` (JWT). Gitignored. Never mounted to an agent.
- `control/` — pure renderers/validation (vitest). `scripts/` — bash glue.

## Use
1. `/setup` — once per server (shared Caddy, wildcard DNS `*.<base> A <ip>`, TLS self-test).
2. `/add-mdz-site` — per site (deploy key → env → clone → up → seed owner → route).

## Notes
- Never `docker compose -p mdz-edge-caddy down -v` (caddy_data = LE certs).
- `MDZ_REF` is pinned to `819bb83` (mdz incl. Phase 2 auth).
- Member emails (`pages/.settings/users.yaml`) are kept off GitHub via `SYNC_EXCLUDE=.auth/,.settings/`.
- The local single-site smoke stack (`compose/docker-compose.yml` + `Caddyfile`) is unchanged and independent of this split.

Agents (general/admin) are Part B — not built yet.
