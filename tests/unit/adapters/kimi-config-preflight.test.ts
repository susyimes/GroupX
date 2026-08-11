import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { preflightKimiUnrestrictedConfig } from "../../../src/adapters/kimi-config-preflight.js";

describe("Kimi unrestricted config preflight", () => {
  it.each(["yolo", "auto"] as const)(
    "accepts %s with effective plan mode disabled and returns no unrelated config",
    async (permissionMode) => {
      const result = await preflightKimiUnrestrictedConfig({
        env: { KIMI_CODE_HOME: "./fixture-kimi-home" },
        readText: async () => `
default_permission_mode = "${permissionMode}"
default_plan_mode = false
default_model = "private-model-alias"
[providers.private]
api_key = "must-not-escape"
`
      });

      expect(result).toEqual({
        permissionMode,
        planMode: false,
        source: "KIMI_CODE_HOME"
      });
      expect(JSON.stringify(result)).not.toContain("private-model-alias");
      expect(JSON.stringify(result)).not.toContain("must-not-escape");
    }
  );

  it("uses the documented false plan default when the key is absent", async () => {
    await expect(
      preflightKimiUnrestrictedConfig({
        env: {},
        homeDirectory: "C:/fixture-user",
        readText: async (configPath) => {
          expect(configPath).toBe(path.join("C:/fixture-user", ".kimi-code", "config.toml"));
          return 'default_permission_mode = "yolo"\n';
        }
      })
    ).resolves.toEqual({
      permissionMode: "yolo",
      planMode: false,
      source: "default-home"
    });
  });

  it("rejects manual permission and enabled plan mode with stable errors", async () => {
    await expect(
      preflightKimiUnrestrictedConfig({
        readText: async () =>
          'default_permission_mode = "manual"\ndefault_plan_mode = false\n'
      })
    ).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message:
        "Kimi unrestricted preflight requires default_permission_mode to be yolo or auto"
    });

    await expect(
      preflightKimiUnrestrictedConfig({
        readText: async () =>
          'default_permission_mode = "yolo"\ndefault_plan_mode = true\n'
      })
    ).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message: "Kimi unrestricted preflight requires default_plan_mode to be false"
    });
  });

  it("does not echo invalid TOML or read failures", async () => {
    await expect(
      preflightKimiUnrestrictedConfig({
        readText: async () => 'api_key = "secret-value"\ninvalid = ['
      })
    ).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message: "Kimi unrestricted preflight found an invalid config.toml"
    });

    const readText = vi.fn(async () => {
      throw new Error("C:/private/config.toml could not be opened with secret-value");
    });
    await expect(
      preflightKimiUnrestrictedConfig({ readText })
    ).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message: "Kimi unrestricted preflight could not read config.toml"
    });
  });
});
