import { describe, it, expect } from "vitest";
import { allConfiguredFailed } from "./source-status.js";

describe("allConfiguredFailed", () => {
  it("is false when any configured source succeeded", () => {
    expect(allConfiguredFailed(["failed", "ok", "unconfigured"])).toBe(false);
  });

  it("is true when every configured source failed", () => {
    expect(allConfiguredFailed(["failed", "unconfigured", "failed"])).toBe(true);
  });

  it("ignores unconfigured sources, so a ProductLift-only setup can fail on its own", () => {
    expect(allConfiguredFailed(["unconfigured", "failed", "unconfigured"])).toBe(true);
    expect(allConfiguredFailed(["unconfigured", "ok", "unconfigured"])).toBe(false);
  });

  it("treats nothing configured as a failure, since there is nothing to analyze", () => {
    expect(allConfiguredFailed(["unconfigured", "unconfigured", "unconfigured"])).toBe(true);
  });
});
