import { describe, expect, it } from "vitest";

import { extractCliVersion } from "../../../src/app/doctor.js";

describe("doctor CLI version projection", () => {
  it("prefers the Hermes semantic version over its parenthesized release date", () => {
    expect(extractCliVersion("Hermes Agent v0.20.1 (2026.8.13)\n")).toBe("0.20.1");
  });

  it("accepts ordinary unprefixed and leading-v semantic versions", () => {
    expect(extractCliVersion("grok 1.0.3")).toBe("1.0.3");
    expect(extractCliVersion("v24.14.1")).toBe("24.14.1");
    expect(extractCliVersion("no version here")).toBeUndefined();
  });
});
