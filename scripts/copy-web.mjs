import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "web");
const destination = path.join(root, "dist", "web");

await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: (entry) => !entry.endsWith(".ts") && !entry.endsWith(".map")
});
