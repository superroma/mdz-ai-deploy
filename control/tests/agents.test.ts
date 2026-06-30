import { describe, expect, it } from "vitest";
import { agentFolder, adminSecretName, siteApiHost, mergeAllowlistRoot } from "../src/agents.js";

describe("naming helpers", () => {
  it("agentFolder", () => {
    expect(agentFolder("demo", "general")).toBe("demo-general");
    expect(agentFolder("demo", "admin")).toBe("admin");
    expect(() => agentFolder("Bad", "general")).toThrow();
  });
  it("adminSecretName / siteApiHost", () => {
    expect(adminSecretName("demo")).toBe("mdz-admin-demo");
    expect(siteApiHost("demo", "example.com")).toBe("demo.example.com");
  });
});

describe("mergeAllowlistRoot", () => {
  it("creates the allowlist when none exists, using allowReadWrite", () => {
    const out = mergeAllowlistRoot(null, { path: "/srv/sites", allowReadWrite: true, description: "mdz content" });
    const j = JSON.parse(out);
    expect(j.allowedRoots).toEqual([{ path: "/srv/sites", allowReadWrite: true, description: "mdz content" }]);
    expect(Array.isArray(j.blockedPatterns)).toBe(true);
  });
  it("drops a legacy readOnly key when updating in place", () => {
    const existing = JSON.stringify({ allowedRoots: [{ path: "/srv/sites", allowReadWrite: false, readOnly: true }], blockedPatterns: [] });
    const out = mergeAllowlistRoot(existing, { path: "/srv/sites", allowReadWrite: true });
    const root = JSON.parse(out).allowedRoots.find((r: any) => r.path === "/srv/sites");
    expect(root.allowReadWrite).toBe(true);
    expect(root.readOnly).toBeUndefined();
  });
  it("updates an existing root in place (idempotent) and preserves siblings", () => {
    const existing = JSON.stringify({
      allowedRoots: [{ path: "/other", allowReadWrite: false }, { path: "/srv/sites", allowReadWrite: false }],
      blockedPatterns: ["custom"],
    });
    const out = mergeAllowlistRoot(existing, { path: "/srv/sites", allowReadWrite: true });
    const j = JSON.parse(out);
    expect(j.allowedRoots).toContainEqual({ path: "/other", allowReadWrite: false });
    expect(j.allowedRoots.find((r: any) => r.path === "/srv/sites").allowReadWrite).toBe(true);
    expect(j.allowedRoots.filter((r: any) => r.path === "/srv/sites")).toHaveLength(1);
    expect(j.blockedPatterns).toContain("custom");
  });
});
