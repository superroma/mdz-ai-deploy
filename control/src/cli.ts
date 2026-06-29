import { validateSiteName } from "./siteName.js";
import { siteDomain, renderSiteEnv, renderCaddySnippet } from "./render.js";

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
      process.stdout.write(renderCaddySnippet(req("domain"), req("site")));
      break;
    default:
      throw new Error(
        `unknown command: ${cmd ?? "(none)"}\n` +
          "commands: site-name, site-domain, render-env, render-snippet"
      );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\n");
  process.exit(1);
}
