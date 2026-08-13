import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeGroupXRuntimeLaunch,
  isAddressInUseError,
  probeGroupXRuntime
} from "../../../src/app/runtime-instance.js";
import { createGroupXRuntimeIdentity } from "../../../src/core/runtime-instance.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configDocument(port: number, identity = "builder") {
  return {
    transport: "structured",
    server: { host: "127.0.0.1", port },
    storage: { path: ".groupx/groupx.db" },
    agents: {
      codex: { command: "codex", cwd: ".", enabled: true, identity }
    }
  };
}

function writeConfig(port: number): string {
  const directory = mkdtempSync(path.join(tmpdir(), "groupx-runtime-instance-"));
  directories.push(directory);
  const configPath = path.join(directory, "groupx.json");
  writeFileSync(configPath, JSON.stringify(configDocument(port)), "utf8");
  return configPath;
}

async function listenWithBody(body: () => unknown): Promise<number> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body()));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture port missing");
  return address.port;
}

describe("GroupX runtime instance discovery", () => {
  it("builds a stable key from canonical config and changes it for semantic edits", async () => {
    const configPath = writeConfig(4_310);
    const first = await describeGroupXRuntimeLaunch(configPath);
    const second = await describeGroupXRuntimeLaunch(configPath);
    expect(second).toEqual(first);
    expect(first.identity).toMatchObject({
      service: "groupx",
      protocol: "groupx.runtime/1",
      runtimeKey: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });

    const reordered = configDocument(4_310);
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: reordered.agents,
        storage: reordered.storage,
        server: reordered.server,
        transport: reordered.transport
      }),
      "utf8"
    );
    expect((await describeGroupXRuntimeLaunch(configPath)).identity.runtimeKey).toBe(
      first.identity.runtimeKey
    );

    writeFileSync(configPath, JSON.stringify(configDocument(4_310, "reviewer")), "utf8");
    const changed = await describeGroupXRuntimeLaunch(configPath);
    expect(changed.identity.runtimeKey).not.toBe(first.identity.runtimeKey);
  });

  it("distinguishes the same runtime, another config, legacy GroupX and foreign HTTP", async () => {
    let responseBody: unknown = {};
    const port = await listenWithBody(() => responseBody);
    const descriptor = await describeGroupXRuntimeLaunch(writeConfig(port));

    responseBody = { status: "ok", ...descriptor.identity };
    await expect(probeGroupXRuntime(descriptor)).resolves.toMatchObject({ kind: "same" });

    responseBody = { status: "ok", ...createGroupXRuntimeIdentity({ other: true }) };
    await expect(probeGroupXRuntime(descriptor)).resolves.toMatchObject({
      kind: "different-config"
    });

    responseBody = {
      status: "ok",
      access: "unrestricted",
      transport: "structured",
      store: { available: true },
      agents: []
    };
    await expect(probeGroupXRuntime(descriptor)).resolves.toEqual({ kind: "legacy-groupx" });

    responseBody = { status: "ok", application: "some-other-server" };
    await expect(probeGroupXRuntime(descriptor)).resolves.toEqual({ kind: "occupied" });

    responseBody = { service: "groupx", protocol: "groupx.runtime/0" };
    await expect(probeGroupXRuntime(descriptor)).resolves.toEqual({
      kind: "incompatible-groupx"
    });
  });

  it("treats an unavailable listener as unreachable and recognizes nested bind errors", async () => {
    const port = await listenWithBody(() => ({}));
    const descriptor = await describeGroupXRuntimeLaunch(writeConfig(port));
    const server = servers.pop();
    if (server === undefined) throw new Error("fixture server missing");
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(probeGroupXRuntime(descriptor, { timeoutMs: 100 })).resolves.toEqual({
      kind: "unreachable"
    });
    expect(isAddressInUseError({ cause: { code: "EADDRINUSE" } })).toBe(true);
    expect(isAddressInUseError({ code: "ECONNREFUSED" })).toBe(false);
  });
});
