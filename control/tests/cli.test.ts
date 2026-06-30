import { describe, expect, it } from "vitest";
import { execa } from "execa";

const RUN = (args: string[]) =>
  execa("node", ["--import", "tsx/esm", "control/src/cli.ts", ...args]);

describe("control cli", () => {
  it("site-domain prints <site>.<base>", async () => {
    const { stdout } = await RUN(["site-domain", "--site=demo", "--base=example.com"]);
    expect(stdout).toBe("demo.example.com");
  });
  it("render-snippet prints a caddy block", async () => {
    const { stdout } = await RUN(["render-snippet", "--domain=demo.example.com", "--site=demo"]);
    expect(stdout).toBe("demo.example.com {\n\treverse_proxy mdz-demo:3001\n}");
  });
  it("render-snippet --http=true prefixes http:// (tunnel mode)", async () => {
    const { stdout } = await RUN(["render-snippet", "--domain=demo.example.com", "--site=demo", "--http=true"]);
    expect(stdout).toBe("http://demo.example.com {\n\treverse_proxy mdz-demo:3001\n}");
  });
  it("repo-slug derives owner/repo from a clone URL", async () => {
    const { stdout } = await RUN(["repo-slug", "--repo=git@github.com:superroma/bridge-home.git"]);
    expect(stdout).toBe("superroma/bridge-home");
  });
  it("render-env includes required keys", async () => {
    const { stdout } = await RUN([
      "render-env", "--site=demo", "--base=example.com",
      "--repo=git@github.com:owner/repo.git", "--ref=819bb83", "--jwt=deadbeef",
    ]);
    expect(stdout).toContain("SITE_NAME=demo");
    expect(stdout).toContain("JWT_SECRET=deadbeef");
  });
  it("render-env threads optional --branch/--pages", async () => {
    const { stdout } = await RUN([
      "render-env", "--site=demo", "--base=example.com",
      "--repo=git@github.com:owner/repo.git", "--ref=819bb83", "--jwt=deadbeef",
      "--branch=dev", "--pages=wiki",
    ]);
    expect(stdout).toContain("SYNC_BRANCH=dev");
    expect(stdout).toContain("PAGES_SUBDIR=wiki");
  });
  it("rejects an invalid site name (exit 1, message on stderr)", async () => {
    const err: any = await RUN(["site-name", "--site=Bad_Name"]).catch((e) => e);
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toMatch(/invalid site name/);
  });
  it("rejects an unknown command (exit 1, message on stderr)", async () => {
    const err: any = await RUN(["bogus"]).catch((e) => e);
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toMatch(/unknown command/);
  });
  it("agent-folder / admin-secret-name / site-api-host", async () => {
    expect((await RUN(["agent-folder", "--site=demo", "--role=general"])).stdout).toBe("demo-general");
    expect((await RUN(["admin-secret-name", "--site=demo"])).stdout).toBe("mdz-admin-demo");
    expect((await RUN(["site-api-host", "--site=demo", "--base=example.com"])).stdout).toBe("demo.example.com");
  });
  it("merge-allowlist-root creates the allowlist when --file is missing", async () => {
    const missing = `/nonexistent-${Date.now()}/mount-allowlist.json`;
    const { stdout } = await RUN([
      "merge-allowlist-root", `--file=${missing}`, "--path=/srv/sites", "--rw=true",
    ]);
    const j = JSON.parse(stdout);
    expect(j.allowedRoots).toContainEqual({ path: "/srv/sites", allowReadWrite: true });
  });
});
