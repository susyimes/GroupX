import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const M0_ACCESS_CONTRACT = "unrestricted-v0.1" as const;
export const M0_AGENTS = ["codex", "grok", "kimi"] as const;
export type M0AgentId = (typeof M0_AGENTS)[number];

export function createM0RunId(date = new Date()): string {
  return date.toISOString().replaceAll(/[-:.]/gu, "");
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function writeM0Report(
  projectRoot: string,
  relativePath: string,
  report: Readonly<Record<string, unknown>>
): Promise<{ absolutePath: string; relativePath: string; sha256: string }> {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("M0 evidence path must remain inside the project root");
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { absolutePath, relativePath: relative.replaceAll("\\", "/"), sha256: await sha256File(absolutePath) };
}

export function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(code)) return code;
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}
