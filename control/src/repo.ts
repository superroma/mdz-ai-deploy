// Derive the GitHub "owner/repo" slug from a clone URL, so callers only ever
// need the URL. Supports scp-style (git@github.com:owner/repo.git),
// ssh://git@host/owner/repo(.git), and https://github.com/owner/repo(.git).
export function repoSlug(url: string): string {
  const u = url.trim();
  let path: string;
  const scp = u.match(/^[^@\s]+@[^:\s]+:(.+)$/); // git@host:owner/repo(.git)
  if (scp) {
    path = scp[1];
  } else {
    const m = u.match(/^[a-z]+:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i); // scheme://[user@]host/owner/repo(.git)
    if (!m) throw new Error(`cannot parse owner/repo from repo URL: ${url}`);
    path = m[1];
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`cannot parse owner/repo from repo URL: ${url}`);
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
