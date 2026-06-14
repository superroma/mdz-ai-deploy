import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../src/config.js";

describe("loadConfigFromEnv", () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD }; });
  afterEach(() => { process.env = OLD; });

  it("reads required values and applies defaults", () => {
    process.env.SYNC_REPO_DIR = "/data/repo";
    const cfg = loadConfigFromEnv();
    expect(cfg.repoDir).toBe("/data/repo");
    expect(cfg.remote).toBe("origin");
    expect(cfg.branch).toBe("main");
    expect(cfg.excludePaths).toEqual([".auth/"]);
    expect(cfg.commitDebounceMs).toBe(5000);
    expect(cfg.pollIntervalMs).toBe(45000);
  });

  it("throws when SYNC_REPO_DIR is missing", () => {
    delete process.env.SYNC_REPO_DIR;
    expect(() => loadConfigFromEnv()).toThrow(/SYNC_REPO_DIR/);
  });

  it("parses excludePaths from a comma list", () => {
    process.env.SYNC_REPO_DIR = "/data/repo";
    process.env.SYNC_EXCLUDE = ".auth/, .secrets/";
    expect(loadConfigFromEnv().excludePaths).toEqual([".auth/", ".secrets/"]);
  });
});
