import { spawn } from "node:child_process";

/**
 * Open the room URL in the system browser without a shell string. Only
 * loopback http URLs are allowed: the broker never serves anything else.
 */
export async function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
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
    child.unref();
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (opened: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(opened);
      };
      child.once("spawn", () => finish(true));
      child.once("error", () => finish(false));
    });
  } catch {
    return false;
  }
}
