import path from "node:path";
import { pathToFileURL } from "node:url";

import { startGroupXRuntime, type GroupXRuntime } from "./app/runtime.js";
import { loadConfig, parseConfigPath } from "./config.js";
import { toSafeErrorBody } from "./contracts/index.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<GroupXRuntime> {
  const config = await loadConfig(parseConfigPath(argv));
  const runtime = await startGroupXRuntime(config);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(toSafeErrorBody(error))}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write(
    `GroupX listening on ${runtime.address?.origin ?? "unknown"} ` +
      `(transport=${config.transport}, access=unrestricted)\n`
  );
  return runtime;
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isEntryModule()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(toSafeErrorBody(error))}\n`);
    process.exitCode = 1;
  });
}
