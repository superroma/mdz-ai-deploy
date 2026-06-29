import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtempSync, rmSync, readFileSync, existsSync, cpSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build a throwaway REPO_ROOT containing only what the scripts need: control/ + scripts/.
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ctl-scripts-"));
  cpSync(join(process.cwd(), "control"), join(root, "control"), { recursive: true });
  cpSync(join(process.cwd(), "scripts"), join(root, "scripts"), { recursive: true });
  // Symlink node_modules instead of copying — near-instant and functionally identical for tsx resolution.
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
  cpSync(join(process.cwd(), "package.json"), join(root, "package.json"));
  return root;
}

describe("offline control scripts", () => {
  let root: string;
  beforeEach(() => { root = fakeRepo(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("render-site-env writes a 600 .env with the right keys", async () => {
    await execa("bash", ["scripts/render-site-env.sh", "demo", "example.com", "git@github.com:o/r.git", "819bb83"], { cwd: root });
    const env = join(root, "secrets/demo/.env");
    expect(existsSync(env)).toBe(true);
    expect(readFileSync(env, "utf8")).toContain("SITE_NAME=demo");
    expect((statSync(env).mode & 0o777).toString(8)).toBe("600");
  });

  it("gen-deploy-key writes a 600 ed25519 key pair, idempotently", async () => {
    await execa("bash", ["scripts/gen-deploy-key.sh", "demo"], { cwd: root });
    const key = join(root, "secrets/demo/deploy_key");
    expect(existsSync(key)).toBe(true);
    expect(existsSync(key + ".pub")).toBe(true);
    expect((statSync(key).mode & 0o777).toString(8)).toBe("600");
    await execa("bash", ["scripts/gen-deploy-key.sh", "demo"], { cwd: root }); // no throw on re-run
  });

  it("register-route writes a caddy snippet for the site", async () => {
    await execa("bash", ["scripts/register-route.sh", "demo", "demo.example.com"], { cwd: root });
    const snip = readFileSync(join(root, "platform/caddy/sites/demo.caddy"), "utf8");
    expect(snip).toBe("demo.example.com {\n\treverse_proxy mdz-demo:3001\n}\n");
  });

  it("rejects an invalid site name", async () => {
    await expect(
      execa("bash", ["scripts/gen-deploy-key.sh", "Bad_Name"], { cwd: root })
    ).rejects.toThrow();
  });
});
