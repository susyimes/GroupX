import { describe, expect, it } from "vitest";

import {
  boundDiagnosticText,
  projectDiagnosticValue
} from "../../../src/observability/diagnostics.js";

describe("boundDiagnosticText", () => {
  it("preserves ordinary content, including token-like text", () => {
    expect(boundDiagnosticText("API_KEY=fake-value sk-FAKE1234567890")).toBe(
      "API_KEY=fake-value sk-FAKE1234567890"
    );
  });

  it("only enforces the requested length bound", () => {
    expect(boundDiagnosticText("0123456789ABC", 10)).toBe("0123456789…[TRUNCATED]");
    expect(() => boundDiagnosticText("text", -1)).toThrowError(RangeError);
  });
});

describe("projectDiagnosticValue", () => {
  it("reports shape rather than copying arbitrary string payloads", () => {
    expect(
      projectDiagnosticValue({
        message: "do not copy me",
        nested: { value: "also omitted" },
        count: 3
      })
    ).toEqual({
      type: "object",
      keys: ["message", "nested", "count"],
      omittedKeyCount: 0
    });
    expect(projectDiagnosticValue("ordinary text")).toEqual({ type: "string", length: 13 });
  });

  it("bounds reported object keys", () => {
    expect(projectDiagnosticValue({ first: 1, second: 2 }, 1)).toEqual({
      type: "object",
      keys: ["first"],
      omittedKeyCount: 1
    });
  });
});
