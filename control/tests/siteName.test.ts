import { describe, expect, it } from "vitest";
import { validateSiteName } from "../src/siteName.js";

describe("validateSiteName", () => {
  it("accepts valid DNS labels", () => {
    for (const ok of ["demo", "a", "site-1", "x9", "a-b-c", "a".repeat(63)]) {
      expect(validateSiteName(ok)).toBe(ok);
    }
  });
  it("rejects invalid names", () => {
    for (const bad of ["", "Demo", "-demo", "demo-", "a.b", "a_b", "a".repeat(64), "déjà"]) {
      expect(() => validateSiteName(bad)).toThrow();
    }
  });
});
