#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd git node
# usage: clone-content.sh <site> <content_repo> [branch]
site="${1:?site}"; repo="${2:?content_repo}"; branch="${3:-main}"
ctl site-name --site="$site" >/dev/null
key="$REPO_ROOT/secrets/$site/deploy_key"
[ -f "$key" ] || die "missing deploy key $key (run gen-deploy-key.sh first)"
dest="$REPO_ROOT/sites/$site/repo"
if [ -d "$dest/.git" ]; then
  log "content already cloned at $dest"
else
  mkdir -p "$REPO_ROOT/sites/$site"
  GIT_SSH_COMMAND="ssh -i '$key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git clone --branch "$branch" "$repo" "$dest"
fi
[ -d "$dest/pages" ] || die "content repo has no pages/ dir at $dest/pages"
if git -C "$dest" ls-files --error-unmatch pages/.settings/users.yaml >/dev/null 2>&1; then
  warn "pages/.settings/users.yaml is tracked; removing from index (file kept on disk)"
  git -C "$dest" rm --cached -q pages/.settings/users.yaml
fi
log "content ready at $dest"
