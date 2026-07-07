#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
require_nanoclaw   # fails fast + actionable if /setup hasn't deployed nanoclaw here
# usage: register-agent.sh general <site> <base> | register-agent.sh admin <base>
# NC_DIR defaults to the toolkit-owned checkout ($REPO_ROOT/nanoclaw); see common.sh.
role="${1:?role (general|admin)}"
abs_sites="$REPO_ROOT/sites"

create_group() { # <name> <folder> -> prints group id
  ncl groups create --name "$1" --folder "$2" | node -e 'process.stdin.resume();let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id)}catch{console.log(s.trim())}})'
}

if [ "$role" = "general" ]; then
  site="${2:?site}"; base="${3:?base}"
  ctl site-name --site="$site" >/dev/null
  folder="$(ctl agent-folder --site="$site" --role=general)"
  [ -d "$abs_sites/$site/repo/pages" ] || die "missing $abs_sites/$site/repo/pages"
  gid="$(create_group "$site general" "$folder")"
  case "$gid" in ""|*[[:space:]]*) die "unexpected group id from ncl: '$gid'";; esac
  ncl groups config update --id "$gid" --provider claude --assistant-name "$site"
  # skills minimal + RO pages mount (no ncl command for these -> helper)
  NC_DIR="$NC_DIR" "$REPO_ROOT/scripts/nc-set-container-json.sh" "$gid" skills '["welcome"]'
  NC_DIR="$NC_DIR" "$REPO_ROOT/scripts/nc-set-container-json.sh" "$gid" additional_mounts \
    "$(printf '[{"hostPath":"%s/%s/repo/pages","containerPath":"pages","readonly":true}]' "$abs_sites" "$site")"
  # operator-editable instructions (thin pointer to the synced file inside the RO mount)
  mkdir -p "$NC_DIR/groups/$folder"
  printf 'Treat /workspace/extra/pages/.mdz/general.md as your operator instructions. You are READ-ONLY over this site'"'"'s pages.\n' \
    > "$NC_DIR/groups/$folder/CLAUDE.local.md"
  mkdir -p "$abs_sites/$site/repo/pages/.mdz"
  [ -f "$abs_sites/$site/repo/pages/.mdz/general.md" ] || printf '# %s general agent\n\nRead-only helper over this site.\n' "$site" > "$abs_sites/$site/repo/pages/.mdz/general.md"
  ncl groups restart --id "$gid"
  log "general agent $folder registered (group $gid). Bind a chat with: ncl messaging-groups create + ncl wirings create."
  printf '%s\n' "$gid"

elif [ "$role" = "admin" ]; then
  base="${2:?base}"
  gid="$(create_group "admin" "admin")"
  case "$gid" in ""|*[[:space:]]*) die "unexpected group id from ncl: '$gid'";; esac
  ncl groups config update --id "$gid" --provider claude --assistant-name "admin"
  NC_DIR="$NC_DIR" "$REPO_ROOT/scripts/nc-set-container-json.sh" "$gid" additional_mounts \
    "$(printf '[{"hostPath":"%s","containerPath":"sites","readonly":false}]' "$abs_sites")"
  mkdir -p "$NC_DIR/groups/admin"
  cat > "$NC_DIR/groups/admin/CLAUDE.local.md" <<MD
You administer all MDZ sites. Content for every site is at /workspace/extra/sites/<site>/repo (READ-WRITE).
To manage users on a site, call its admin API at https://<site>.${base}/api/admin/* — the gateway injects that
site's admin token automatically (you never see the raw token). To change a site's general-agent instructions,
edit /workspace/extra/sites/<site>/repo/pages/.mdz/general.md. You can never see deploy keys or JWT secrets.
MD
  # Assign every existing site's admin secret to THIS agent only (OneCLI agent identity = group id-derived).
  log "Now: for each site run scripts/mint-site-admin-secret.sh <site>, then 'onecli agents set-secrets' to assign mdz-admin-<site> to this admin agent ONLY; set NANOCLAW_EGRESS_LOCKDOWN=true."
  ncl groups restart --id "$gid"
  log "admin agent registered (group $gid)."
  printf '%s\n' "$gid"
else
  die "unknown role: $role (general|admin)"
fi
