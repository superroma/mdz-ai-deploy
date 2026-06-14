# Phase 1 smoke test (data plane)

Verifies end-to-end that:
1. The MDZ image builds and serves through Caddy.
2. The sidecar commits + pushes local edits to the remote.
3. A remote (GitHub-authority) push wins over local (remote-wins).

It uses a **throwaway local bare repo as "GitHub"** so no network, GitHub, or
real SSH key is needed. The local override (`compose/docker-compose.smoke.yml`)
bind-mounts that repo into the sidecar at `/origin` so the working tree's
`origin` remote resolves inside the container.

> Production note: in a real deployment the content repo's `origin` is
> `git@github.com:owner/repo.git` and the sidecar authenticates with the deploy
> key mounted at `/keys/deploy_key`. That key file **must exist and be `chmod
> 600`** before `docker compose up`, otherwise the bind mount creates a
> *directory* at that path and SSH fails with a confusing error. The smoke test
> below sidesteps SSH entirely by using a `file://` remote.

Requires the Docker daemon running (OrbStack on this machine).

## 1. Make a throwaway "GitHub" repo with a `pages/` tree

```bash
export R=$(mktemp -d)
git init --bare -b main "$R/origin.git"
git clone "$R/origin.git" "$R/seed"
mkdir -p "$R/seed/pages"
printf '# Welcome\n\nhello\n' > "$R/seed/pages/Welcome.md"
git -C "$R/seed" -c user.email=s@s -c user.name=seed add -A
git -C "$R/seed" -c user.email=s@s -c user.name=seed commit -m "seed pages"
git -C "$R/seed" push origin main
touch "$R/deploy_key"   # dummy; unused by the file:// remote, but the mount needs a file
echo "ORIGIN at $R/origin.git"
```

## 2. Build images and create the stack (don't start yet)

Use project name `mdzsmoke` so the volume name is predictable (`mdzsmoke_repo`).
`SITE_DOMAIN=:80` makes Caddy serve plain HTTP locally (no ACME/TLS).

```bash
cd compose
export SITE_DOMAIN=:80 MDZ_REF=main PAGES_SUBDIR=pages JWT_SECRET=dev \
  SYNC_BRANCH=main SYNC_DEBOUNCE_MS=1000 SYNC_POLL_MS=3000 SYNC_EXCLUDE=.auth/ \
  SYNC_BOT_NAME=mdz-bot SYNC_BOT_EMAIL=bot@mdz.local \
  DEPLOY_KEY="$R/deploy_key" SMOKE_ORIGIN_DIR="$R"
docker compose -p mdzsmoke -f docker-compose.yml -f docker-compose.smoke.yml up --build --no-start
```

## 3. Seed the shared volume, then start

The working tree is cloned from the bind-mounted origin so its remote
(`/origin/origin.git`) is valid inside the containers.

The volume is mounted at `/data/repo` (the same path the sidecar uses) and the
clone target is that mount, so the repo lands exactly where the sidecar expects
it — no nested `repo/repo`.

```bash
docker run --rm -v mdzsmoke_repo:/data/repo -v "$R":/origin alpine/git \
  clone /origin/origin.git /data/repo
docker compose -p mdzsmoke -f docker-compose.yml -f docker-compose.smoke.yml start
```

## 4. Verify MDZ serves through Caddy

```bash
sleep 5
curl -s localhost/api/health    # expect {"status":"ok", ...}
```

## 5. Verify local -> remote sync

```bash
docker run --rm -v mdzsmoke_repo:/data/repo alpine sh -c \
  'echo "# Edited locally" > /data/repo/pages/Welcome.md'
sleep 4
git -C "$R/origin.git" log --oneline    # expect an "Auto-save ..." commit
```

## 6. Verify remote-wins

```bash
git -C "$R/seed" pull --ff-only origin main
printf '# From GitHub\n' > "$R/seed/pages/Welcome.md"
git -C "$R/seed" -c user.email=s@s -c user.name=seed commit -am "remote edit"
git -C "$R/seed" push origin main
sleep 6
docker run --rm -v mdzsmoke_repo:/data/repo alpine cat /data/repo/pages/Welcome.md
# expect: "# From GitHub"  (remote won)
```

## 7. Tear down

```bash
docker compose -p mdzsmoke -f docker-compose.yml -f docker-compose.smoke.yml down -v
rm -rf "$R"
```
