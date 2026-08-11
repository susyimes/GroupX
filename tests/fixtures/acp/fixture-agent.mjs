import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, resolve } from "node:path";

const configPath = resolve(process.cwd(), "fixture-config.json");
const logPath = resolve(process.cwd(), "wire-log.jsonl");
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8"))
  : {};

let sessionCounter = 0;
let promptCounter = 0;
let activePrompt;
let pendingSetModePermission;

record({
  direction: "fixture",
  event: "startup",
  script: basename(process.argv[1] ?? ""),
  argv: process.argv.slice(2)
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write("fixture received malformed JSON\n");
    return;
  }
  record({ direction: "in", frame });
  handle(frame);
});
lines.on("close", () => {
  record({ direction: "fixture", event: "stdin_closed" });
});

function handle(frame) {
  if (typeof frame?.method === "string") {
    handleMethod(frame);
    return;
  }
  if (pendingSetModePermission !== undefined && sameId(frame?.id, pendingSetModePermission.requestId)) {
    const pending = pendingSetModePermission;
    pendingSetModePermission = undefined;
    send({ jsonrpc: "2.0", id: pending.setModeRequestId, result: {} });
    return;
  }
  if (activePrompt?.permissionRequestId !== undefined && sameId(frame?.id, activePrompt.permissionRequestId)) {
    activePrompt.permissionResponse = frame.result;
    if (config.prompt?.permissionAfterCancel && activePrompt.cancelReceived) {
      finishPrompt(activePrompt, "cancelled");
      return;
    }
    if (!config.prompt?.holdUntilCancel) {
      scheduleTerminal(activePrompt);
    }
  }
}

function handleMethod(frame) {
  switch (frame.method) {
    case "initialize":
      if (typeof config.stderrAfterInitialize === "string") {
        process.stderr.write(config.stderrAfterInitialize);
      }
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: config.protocolVersion ?? 1,
          agentCapabilities: config.agentCapabilities ?? {
            loadSession: true,
            mcpCapabilities: { http: true },
            sessionCapabilities: { close: {} }
          },
          agentInfo: {
            name: config.agentName ?? "groupx-acp-fixture",
            version: config.agentVersion ?? "1.0.0"
          },
          authMethods: []
        }
      });
      return;
    case "initialized":
      // ACP v1 has no initialized notification. Keep it in the log so tests can
      // prove the client never emits this Codex/MCP-style message.
      return;
    case "session/new":
      if (config.sessionNewError !== undefined) {
        send({ jsonrpc: "2.0", id: frame.id, error: config.sessionNewError });
        return;
      }
      sessionCounter += 1;
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: { sessionId: config.sessionId ?? `fixture-session-${sessionCounter}` }
      });
      return;
    case "session/load":
      if (config.replayOnLoad) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: frame.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "replay-message",
              content: { type: "text", text: "replayed history" }
            }
          }
        });
      }
      send({ jsonrpc: "2.0", id: frame.id, result: null });
      return;
    case "session/set_mode":
      if (config.setMode?.emitUpdates) {
        sendUpdate(frame.params.sessionId, {
          sessionUpdate: "current_mode_update",
          currentModeId: frame.params.modeId
        });
        sendUpdate(frame.params.sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: []
        });
      }
      if (config.setMode?.hang) {
        return;
      }
      if (config.setMode?.permission) {
        const requestId = config.setMode.permissionRequestId ?? 650;
        pendingSetModePermission = { requestId, setModeRequestId: frame.id };
        send({
          jsonrpc: "2.0",
          id: requestId,
          method: "session/request_permission",
          params: {
            sessionId: frame.params.sessionId,
            toolCall: { toolCallId: "set-mode-tool", title: "Set mode permission" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
          }
        });
        return;
      }
      if (config.setMode?.error !== undefined) {
        send({ jsonrpc: "2.0", id: frame.id, error: config.setMode.error });
        return;
      }
      send({ jsonrpc: "2.0", id: frame.id, result: {} });
      return;
    case "session/prompt":
      beginPrompt(frame);
      return;
    case "session/cancel":
      if (activePrompt !== undefined) {
        const current = activePrompt;
        current.cancelReceived = true;
        if (config.prompt?.permissionAfterCancel) {
          sendPermission(current);
          return;
        }
        const delay = config.prompt?.cancelDelayMs ?? 0;
        setTimeout(() => finishPrompt(current, "cancelled"), delay);
      }
      return;
    case "session/close":
      send({ jsonrpc: "2.0", id: frame.id, result: {} });
      return;
    default:
      if (Object.hasOwn(frame, "id")) {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32601, message: `Method not found: ${frame.method}` }
        });
      }
  }
}

function beginPrompt(frame) {
  promptCounter += 1;
  const promptConfig = config.prompt ?? {};
  const sessionId = frame.params.sessionId;
  const current = {
    id: frame.id,
    sessionId,
    sequence: promptCounter,
    finished: false,
    terminalScheduled: false,
    permissionRequestId:
      promptConfig.permission || promptConfig.permissionAfterCancel
        ? promptConfig.permissionRequestId ?? 700 + promptCounter
        : undefined
  };
  activePrompt = current;

  if (promptConfig.emitUpdates !== false) {
    sendUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: `message-${promptCounter}`,
      content: { type: "text", text: promptConfig.messageText ?? "fixture answer" }
    });
    sendUpdate(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      messageId: `thought-${promptCounter}`,
      content: { type: "text", text: "fixture thought" }
    });
    sendUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: `tool-${promptCounter}`,
      title: "Fixture tool",
      kind: "other",
      status: "pending",
      rawInput: { intentionally: "not projected" }
    });
    sendUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: `tool-${promptCounter}`,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "done" } }],
      rawOutput: { intentionally: "not projected" }
    });
  }

  if (promptConfig.idleBeforeTerminal) {
    sendUpdate(sessionId, { sessionUpdate: "state_change", state: "idle" });
  }
  if (promptConfig.orphanResponse) {
    send({ jsonrpc: "2.0", id: "not-the-prompt", result: { stopReason: "end_turn" } });
  }
  if (promptConfig.malformedAfterUpdate) {
    process.stdout.write("this is not json\n");
    return;
  }
  if (promptConfig.exitAfterUpdate) {
    setImmediate(() => process.exit(promptConfig.exitCode ?? 7));
    return;
  }
  if (promptConfig.permission) {
    sendPermission(current);
    return;
  }
  if (promptConfig.permissionAfterCancel) {
    return;
  }
  if (!promptConfig.holdUntilCancel) {
    scheduleTerminal(current);
  }
}

function sendPermission(current) {
  const baseParams = {
    sessionId: config.prompt?.permissionSessionId ?? current.sessionId,
    toolCall: {
      toolCallId: `tool-${current.sequence}`,
      title: "Fixture permission"
    },
    options: config.prompt?.permissionOptions ?? [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once", fixtureTag: "a" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once", fixtureTag: "r" }
    ]
  };
  send({
    jsonrpc: "2.0",
    id: current.permissionRequestId,
    method: "session/request_permission",
    params: {
      ...baseParams,
      ...(config.prompt?.permissionPolicyBlock ? { _meta: { policyBlocked: true } } : {})
    }
  });
}

function scheduleTerminal(current) {
  if (current.finished || current.terminalScheduled || config.prompt?.holdUntilCancel) {
    return;
  }
  current.terminalScheduled = true;
  setTimeout(
    () => finishPrompt(current, config.prompt?.stopReason ?? "end_turn"),
    config.prompt?.terminalDelayMs ?? 0
  );
}

function finishPrompt(current, stopReason) {
  if (current.finished) {
    return;
  }
  current.finished = true;
  if (activePrompt === current) {
    activePrompt = undefined;
  }
  send({
    jsonrpc: "2.0",
    id: current.id,
    result: {
      stopReason,
      userMessageId: `user-message-${current.sequence}`
    }
  });
}

function sendUpdate(sessionId, update) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update }
  });
}

function send(frame) {
  record({ direction: "out", frame });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function record(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function sameId(left, right) {
  return typeof left === typeof right && left === right;
}
