import { describe, expect, it } from "vitest";
import { siteDomain, renderSiteEnv, renderCaddySnippet } from "../src/render.js";

describe("siteDomain", () => {
  it("joins site and base", () => {
    expect(siteDomain("demo", "example.com")).toBe("demo.example.com");
  });
  it("validates the site name", () => {
    expect(() => siteDomain("Bad", "example.com")).toThrow();
  });
});

describe("renderCaddySnippet", () => {
  it("emits a reverse_proxy block targeting the per-site alias", () => {
    expect(renderCaddySnippet("demo.example.com", "demo")).toBe(
      "demo.example.com {\n\treverse_proxy mdz-demo:3001\n}\n"
    );
  });
  it("prefixes http:// in tunnel mode so Caddy serves on :80", () => {
    expect(renderCaddySnippet("demo.example.com", "demo", { http: true })).toBe(
      "http://demo.example.com {\n\treverse_proxy mdz-demo:3001\n}\n"
    );
  });
});

describe("renderSiteEnv", () => {
  const base = {
    site: "demo", baseDomain: "example.com",
    contentRepo: "git@github.com:owner/repo.git", mdzRef: "819bb83", jwtSecret: "deadbeef",
  };
  it("renders required keys and defaults", () => {
    const env = renderSiteEnv(base);
    expect(env).toContain("SITE_NAME=demo");
    expect(env).toContain("BASE_DOMAIN=example.com");
    expect(env).toContain("MDZ_REF=819bb83");
    expect(env).toContain("CONTENT_REPO=git@github.com:owner/repo.git");
    expect(env).toContain("JWT_SECRET=deadbeef");
    expect(env).toContain("SYNC_BRANCH=main");
    expect(env).toContain("PAGES_SUBDIR=pages");
    expect(env).toContain("SYNC_EXCLUDE=.auth/,.settings/");
    expect(env.endsWith("\n")).toBe(true);
  });
  it("honors branch/pages overrides", () => {
    const env = renderSiteEnv({ ...base, branch: "dev", pagesSubdir: "wiki" });
    expect(env).toContain("SYNC_BRANCH=dev");
    expect(env).toContain("PAGES_SUBDIR=wiki");
  });
});
