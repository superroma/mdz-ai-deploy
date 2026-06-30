import { describe, expect, it } from "vitest";
import { repoSlug } from "../src/repo.js";

describe("repoSlug", () => {
  it("parses scp-style ssh urls", () => {
    expect(repoSlug("git@github.com:superroma/bridge-home.git")).toBe("superroma/bridge-home");
    expect(repoSlug("git@github.com:superroma/bridge-home")).toBe("superroma/bridge-home");
  });
  it("parses ssh:// and https:// urls", () => {
    expect(repoSlug("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(repoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(repoSlug("https://github.com/owner/repo")).toBe("owner/repo");
  });
  it("trims whitespace and trailing slashes", () => {
    expect(repoSlug("  git@github.com:owner/repo.git  ")).toBe("owner/repo");
    expect(repoSlug("https://github.com/owner/repo/")).toBe("owner/repo");
  });
  it("throws on unparseable input", () => {
    expect(() => repoSlug("not-a-url")).toThrow();
    expect(() => repoSlug("git@github.com:onlyowner")).toThrow();
  });
});
