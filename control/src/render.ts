import { validateSiteName } from "./siteName.js";

export interface SiteEnvInputs {
  site: string;
  baseDomain: string;
  contentRepo: string;
  mdzRef: string;
  jwtSecret: string;
  branch?: string;
  pagesSubdir?: string;
}

export function siteDomain(site: string, baseDomain: string): string {
  return `${validateSiteName(site)}.${baseDomain}`;
}

export function renderSiteEnv(i: SiteEnvInputs): string {
  validateSiteName(i.site);
  const branch = i.branch ?? "main";
  const pagesSubdir = i.pagesSubdir ?? "pages";
  return (
    [
      `SITE_NAME=${i.site}`,
      `BASE_DOMAIN=${i.baseDomain}`,
      `MDZ_REF=${i.mdzRef}`,
      `CONTENT_REPO=${i.contentRepo}`,
      `SYNC_BRANCH=${branch}`,
      `PAGES_SUBDIR=${pagesSubdir}`,
      `JWT_SECRET=${i.jwtSecret}`,
      `SYNC_BOT_NAME=mdz-bot`,
      `SYNC_BOT_EMAIL=bot@mdz.local`,
      `SYNC_DEBOUNCE_MS=5000`,
      `SYNC_POLL_MS=45000`,
      `SYNC_EXCLUDE=.auth/,.settings/`,
    ].join("\n") + "\n"
  );
}

// In tunnel mode (`http: true`) the address gets an explicit `http://` scheme so
// Caddy serves the host on :80 (TLS is terminated upstream at the Cloudflare tunnel).
// A bare hostname would default to :443, which the tunnel never reaches.
export function renderCaddySnippet(domain: string, site: string, opts?: { http?: boolean }): string {
  validateSiteName(site);
  const addr = opts?.http ? `http://${domain}` : domain;
  return `${addr} {\n\treverse_proxy mdz-${site}:3001\n}\n`;
}
