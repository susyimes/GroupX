import { spawn } from "node:child_process";

/**
 * Open the room URL in the system browser without a shell string. Only
 * loopback http URLs are allowed: the broker never serves anything else.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/u.test(url)) {
    return false;
  }
  try {
    const child =
      platform === "win32"
        ? spawn("cmd", ["/d", "/c", "start", "", url], { detached: true, stdio: "ignore" })
        : platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
