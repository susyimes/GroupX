import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, resolve } from "node:path";

const configPath = resolve(process.cwd(), "fixture-config.json");
const logPath = resolve(process.cwd(), "wire-log.jsonl");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

const requestedSessionId = flag("--session-id") ?? flag("--resume");
const sessionId = config.sessionId ?? requestedSessionId ?? "fixture-session";
const permissionMode = config.permissionMode ?? flag("--permission-mode") ?? "default";

let promptCounter = 0;
let activeTurn;
let initFrameSent = false;
let strayResultOwed = false;

record({ direction: "fixture", event: "startup", script: basename(process.argv[1] ?? ""), argv });

if (config.exitBeforeHandshake === true) {
  if (typeof config.stderrBeforeExit === "string") {
    process.stderr.write(config.stderrBeforeExit);
  }
  process.exit(config.exitCode ?? 9);
}

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
  process.exit(config.exitCode ?? 0);
});

function handle(frame) {
  if (frame?.type === "control_request") {
    handleControlRequest(frame);
    return;
  }
  if (frame?.type === "control_response") {
    // The adapter answered a permission request; nothing else is expected.
    return;
  }
  if (frame?.type === "user") {
    beginTurn();
  }
}

function handleControlRequest(frame) {
  const subtype = frame.request?.subtype;

  if (subtype === "initialize") {
    if (config.noHandshakeResponse === true) {
      return;
    }
    if (config.initializeError !== undefined) {
      controlError(frame.request_id, config.initializeError);
      return;
    }
    const initializePayload = {
      // The real payload also carries account/model/command inventories the
      // adapter must not collect. Keep them here so the projection is tested.
      account: { email: "fixture@example.invalid", organization: "fixture-org" },
      commands: [{ name: "fixture", description: "not collected" }],
      models: [{ value: "default" }],
      pid: process.pid
    };
    if (config.omitInitializePermissionMode !== true) {
      initializePayload.current_permission_mode = permissionMode;
    }
    controlSuccess(frame.request_id, initializePayload);
    return;
  }

  if (subtype === "set_permission_mode") {
    if (config.setModeHang === true) {
      return;
    }
    if (config.setModeError !== undefined) {
      controlError(frame.request_id, config.setModeError);
      return;
    }
    controlSuccess(frame.request_id, { mode: config.setModeResult ?? frame.request?.mode ?? permissionMode });
    return;
  }

  if (subtype === "interrupt") {
    controlSuccess(frame.request_id, { still_queued: [] });
    if (activeTurn === undefined || config.prompt?.ignoreInterrupt === true) {
      return;
    }
    const current = activeTurn;
    current.cancelReceived = true;
    if (config.prompt?.completeOnInterrupt === true) {
      // The interrupt loses the race: the turn settles as a normal completion
      // and the CLI still owes a second result answering the interrupt.
      finishTurn(current, { subtype: "success", terminalReason: "completed" });
      strayResultOwed = true;
      return;
    }
    setTimeout(
      () =>
        finishTurn(current, {
          subtype: "error_during_execution",
          terminalReason: config.prompt?.cancelTerminalReason ?? "aborted_streaming",
          isError: true
        }),
      config.prompt?.cancelDelayMs ?? 0
    );
    return;
  }

  controlError(frame.request_id, `unsupported subtype: ${String(subtype)}`);
}

function beginTurn() {
  promptCounter += 1;
  const promptConfig = config.prompt ?? {};
  const current = { sequence: promptCounter, finished: false, cancelReceived: false };
  activeTurn = current;

  // Claude Code defers the init frame until the first user message.
  if (!initFrameSent && config.noInitFrame !== true) {
    initFrameSent = true;
    const init = {
      type: "system",
      subtype: "init",
      cwd: config.cwd ?? process.cwd(),
      session_id: sessionId,
      tools: config.tools ?? ["Bash", "Read", "Edit"],
      mcp_servers: config.mcpServers ?? [],
      model: "fixture-model",
      permissionMode: config.initPermissionMode ?? permissionMode,
      claude_code_version: config.version ?? "2.1.233",
      uuid: "init-uuid"
    };
    if (config.malformedInit === true) {
      delete init.session_id;
    }
    send(init);
  }

  // The answer the CLI owes for the lost interrupt lands after the next turn
  // has already started.
  if (strayResultOwed) {
    strayResultOwed = false;
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      stop_reason: null,
      num_turns: promptCounter - 1,
      session_id: sessionId,
      uuid: `stray-${promptCounter - 1}`
    });
  }

  const messageId = `msg_fixture_${promptCounter}`;
  if (promptConfig.emitEvents !== false) {
    streamEvent({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [] } });
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "fixture thought" } });
    streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    streamEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: promptConfig.messageText ?? "fixture answer" }
    });
    streamEvent({
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: `toolu_${promptCounter}`, name: "Bash", input: {} }
    });
    // Complete assistant message: the text was already streamed, so the adapter
    // must not duplicate it and must not re-open the same tool use.
    send({
      type: "assistant",
      message: {
        id: messageId,
        role: "assistant",
        content: [
          { type: "text", text: promptConfig.messageText ?? "fixture answer" },
          { type: "tool_use", id: `toolu_${promptCounter}`, name: "Bash", input: { command: "echo hi" } }
        ]
      },
      session_id: sessionId
    });
    send({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `toolu_${promptCounter}`, content: "hi", is_error: false }]
      },
      session_id: sessionId
    });
  }

  if (promptConfig.messageStartWithoutId === true) {
    // A second message opens with no id; its text must not be attributed to the
    // previous message's dedupe key.
    streamEvent({ type: "message_start", message: { type: "message", role: "assistant", content: [] } });
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second message" } });
    send({
      type: "assistant",
      message: { id: messageId, role: "assistant", content: [{ type: "text", text: "fixture answer" }] },
      session_id: sessionId
    });
  }

  if (promptConfig.toolUseWithoutId === true) {
    streamEvent({
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", name: "Bash", input: {} }
    });
  }

  if (promptConfig.unstreamedAssistant === true) {
    send({
      type: "assistant",
      message: {
        id: `msg_fallback_${promptCounter}`,
        role: "assistant",
        content: [{ type: "text", text: "fallback text" }]
      },
      session_id: sessionId
    });
  }

  if (promptConfig.foreignSession === true) {
    send({
      type: "assistant",
      message: { id: "foreign", role: "assistant", content: [{ type: "text", text: "other room" }] },
      session_id: "some-other-session"
    });
  }

  if (promptConfig.malformedAfterEvents === true) {
    process.stdout.write("this is not json\n");
    return;
  }
  if (promptConfig.exitAfterEvents === true) {
    setImmediate(() => process.exit(promptConfig.exitCode ?? 7));
    return;
  }
  if (promptConfig.permission === true) {
    send({
      type: "control_request",
      request_id: `perm-${promptCounter}`,
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } }
    });
    return;
  }
  if (promptConfig.userDialog === true) {
    send({
      type: "control_request",
      request_id: `dialog-${promptCounter}`,
      request: { subtype: "request_user_dialog", dialog_kind: "confirm", payload: { message: "proceed?" } }
    });
    return;
  }
  if (promptConfig.unknownControlRequest === true) {
    send({ type: "control_request", request_id: `hook-${promptCounter}`, request: { subtype: "hook_callback" } });
  }
  if (promptConfig.holdUntilCancel === true && !(promptConfig.holdFirstTurnOnly === true && promptCounter > 1)) {
    return;
  }
  setTimeout(
    () =>
      finishTurn(current, {
        subtype: promptConfig.subtype ?? "success",
        terminalReason: promptConfig.terminalReason ?? "completed",
        isError: promptConfig.isError ?? false
      }),
    promptConfig.terminalDelayMs ?? 0
  );
}

function finishTurn(current, outcome) {
  if (current.finished) {
    return;
  }
  current.finished = true;
  if (activeTurn === current) {
    activeTurn = undefined;
  }
  const frame = {
    type: "result",
    subtype: outcome.subtype,
    is_error: outcome.isError ?? false,
    terminal_reason: outcome.terminalReason,
    stop_reason: outcome.subtype === "success" ? "end_turn" : null,
    num_turns: current.sequence,
    result: outcome.subtype === "success" ? "fixture answer" : undefined,
    usage: { input_tokens: 10, output_tokens: 20 },
    session_id: sessionId,
    uuid: `result-${current.sequence}`
  };
  if (typeof config.prompt?.apiErrorStatus === "number") {
    frame.api_error_status = config.prompt.apiErrorStatus;
  }
  send(frame);
}

function controlSuccess(requestId, response) {
  send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

function controlError(requestId, error) {
  send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
}

function streamEvent(event) {
  send({ type: "stream_event", event, session_id: sessionId, parent_tool_use_id: null });
}

function send(frame) {
  record({ direction: "out", frame });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function record(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}
