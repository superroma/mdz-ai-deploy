import { validateSiteName } from "./siteName.js";

export function agentFolder(site: string, role: "general" | "admin"): string {
  if (role === "admin") return "admin";
  return `${validateSiteName(site)}-general`;
}

export function adminSecretName(site: string): string {
  return `mdz-admin-${validateSiteName(site)}`;
}

export function siteApiHost(site: string, baseDomain: string): string {
  return `${validateSiteName(site)}.${baseDomain}`;
}

interface AllowedRoot { path: string; allowReadWrite: boolean; description?: string }
interface Allowlist { allowedRoots: AllowedRoot[]; blockedPatterns: string[] }

export function mergeAllowlistRoot(
  json: string | null,
  root: AllowedRoot
): string {
  const base: Allowlist = json
    ? (JSON.parse(json) as Allowlist)
    : { allowedRoots: [], blockedPatterns: [] };
  base.allowedRoots = base.allowedRoots ?? [];
  base.blockedPatterns = base.blockedPatterns ?? [];
  const idx = base.allowedRoots.findIndex((r) => r.path === root.path);
  if (idx >= 0) base.allowedRoots[idx] = { ...base.allowedRoots[idx], ...root };
  else base.allowedRoots.push(root);
  return JSON.stringify(base, null, 2) + "\n";
}
