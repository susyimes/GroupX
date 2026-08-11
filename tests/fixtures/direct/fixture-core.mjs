import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const agent = basename(process.argv[1] ?? "").replace(/\.mjs$/i, "");
const args = process.argv.slice(2);
const configPath = resolve(process.cwd(), "fixture-config.json");
const logPath = resolve(process.cwd(), "wire-log.jsonl");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
let stdin = "";

record({ event: "startup", agent, argv: args });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  record({ event: "stdin", text: stdin });
  void run();
});
process.stdin.resume();

async function run() {
  if (config.policyStderr) {
    process.stderr.write(`${config.policyStderr}\n`);
  }
  if (config.delayFirstMs) {
    await delay(config.delayFirstMs);
  }
  if (config.hold) {
    spawnDescendantIfRequested();
    setInterval(() => undefined, 1_000);
    return;
  }
  if (config.malformed) {
    process.stdout.write("this is not json\n");
    return;
  }
  if (config.truncated) {
    process.stdout.write('{"type":"unfinished"');
    return;
  }
  if (config.policyStdout) {
    send({ type: "error", message: config.policyStdout });
    return;
  }
  if (config.interaction) {
    send({
      type: config.interaction,
      ...(config.interactionDiagnostic ? { message: config.interactionDiagnostic } : {})
    });
    setInterval(() => undefined, 1_000);
    return;
  }

  const sessionId = config.sessionId ?? resumeSessionId() ?? "fixture-session";
  if (agent === "codex") {
    send({ type: "thread.started", thread_id: sessionId });
    send({ type: "turn.started" });
    if (config.intermediateError) {
      send({ type: "error", message: "recoverable reconnect diagnostic" });
    }
    send({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: config.text ?? "codex answer" }
    });
    if (config.holdAfterFirst) return holdAfterFirst();
    if (!config.noTerminal) send({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
  } else if (agent === "grok") {
    send({ type: "text", data: config.text ?? "grok answer" });
    if (config.holdAfterFirst) return holdAfterFirst();
    if (!config.noTerminal) {
      send({ type: "end", stopReason: config.stopReason ?? "end_turn", sessionId, requestId: "request-1" });
    }
  } else if (agent === "kimi") {
    send({ role: "meta", type: "system.version", version: "0.34.0" });
    send({ role: "assistant", content: config.text ?? "kimi answer" });
    if (config.holdAfterFirst) return holdAfterFirst();
    if (!config.noTerminal) {
      send({
        role: "meta",
        type: "session.resume_hint",
        session_id: sessionId,
        command: `kimi -r ${sessionId}`
      });
    }
  } else {
    process.stderr.write(`unknown fixture agent: ${agent}\n`);
    process.exitCode = 3;
  }

  if (config.extraAfterTerminal) {
    send({ type: "text", content: "late" });
  }
  if (config.exitCode) {
    process.exitCode = config.exitCode;
  }
}

function holdAfterFirst() {
  spawnDescendantIfRequested();
  setInterval(() => undefined, 1_000);
}

function spawnDescendantIfRequested() {
  if (!config.spawnDescendant) return;
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true
  });
  record({ event: "descendant", pid: descendant.pid });
}

function resumeSessionId() {
  if (agent === "codex") {
    const index = args.indexOf("resume");
    return index < 0 ? undefined : args[index + 2];
  }
  if (agent === "grok") {
    const index = args.indexOf("--resume");
    return index < 0 ? undefined : args[index + 1];
  }
  if (agent === "kimi") {
    const index = args.indexOf("--session");
    return index < 0 ? undefined : args[index + 1];
  }
  return undefined;
}

function send(value) {
  record({ event: "stdout", value });
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function record(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
