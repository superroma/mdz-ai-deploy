import { existsSync, readFileSync } from "node:fs";
import { validateSiteName } from "./siteName.js";
import { siteDomain, renderSiteEnv, renderCaddySnippet } from "./render.js";
import { agentFolder, adminSecretName, siteApiHost, mergeAllowlistRoot } from "./agents.js";
import { repoSlug } from "./repo.js";

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.slice(3).find((a) => a.startsWith(pfx));
  return hit?.slice(pfx.length);
}
function req(name: string): string {
  const v = arg(name);
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

function main(): void {
  const cmd = process.argv[2];
  switch (cmd) {
    case "site-name":
      process.stdout.write(validateSiteName(req("site")) + "\n");
      break;
    case "site-domain":
      process.stdout.write(siteDomain(req("site"), req("base")) + "\n");
      break;
    case "render-env":
      process.stdout.write(
        renderSiteEnv({
          site: req("site"), baseDomain: req("base"), contentRepo: req("repo"),
          mdzRef: req("ref"), jwtSecret: req("jwt"),
          branch: arg("branch"), pagesSubdir: arg("pages"),
        })
      );
      break;
    case "render-snippet":
      process.stdout.write(renderCaddySnippet(req("domain"), req("site"), { http: arg("http") === "true" }));
      break;
    case "repo-slug":
      process.stdout.write(repoSlug(req("repo")) + "\n");
      break;
    case "agent-folder":
      process.stdout.write(agentFolder(req("site"), req("role") as "general" | "admin") + "\n");
      break;
    case "admin-secret-name":
      process.stdout.write(adminSecretName(req("site")) + "\n");
      break;
    case "site-api-host":
      process.stdout.write(siteApiHost(req("site"), req("base")) + "\n");
      break;
    case "merge-allowlist-root": {
      const file = req("file");
      const cur = existsSync(file) ? readFileSync(file, "utf8") : null;
      const desc = arg("desc");
      const root: { path: string; allowReadWrite: boolean; description?: string } = {
        path: req("path"),
        allowReadWrite: arg("rw") === "true",
      };
      if (desc !== undefined) root.description = desc;
      process.stdout.write(mergeAllowlistRoot(cur, root));
      break;
    }
    default:
      throw new Error(
        `unknown command: ${cmd ?? "(none)"}\n` +
          "commands: site-name, site-domain, render-env, render-snippet, repo-slug, " +
          "agent-folder, admin-secret-name, site-api-host, merge-allowlist-root"
      );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\n");
  process.exit(1);
}
