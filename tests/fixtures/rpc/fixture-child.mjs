import readline from "node:readline";
import { spawn } from "node:child_process";

const dialectArg = process.argv.find((argument) => argument.startsWith("--dialect="));
const eofArg = process.argv.find((argument) => argument.startsWith("--eof="));
const dialect = dialectArg?.slice("--dialect=".length) ?? "acp";
const ignoreEof = eofArg?.slice("--eof=".length) === "ignore";
const heldOpen = ignoreEof ? setInterval(() => undefined, 1_000) : undefined;
const watchdog = setTimeout(() => process.exit(97), 30_000);
watchdog.unref();

let initialized = false;
let requestCount = 0;
let responseCount = 0;
const pendingServerRequests = new Map();

function key(id) {
  return `${typeof id}:${String(id)}`;
}

function frame(message) {
  return dialect === "acp" ? { jsonrpc: "2.0", ...message } : message;
}

function write(message, ending = "\n") {
  process.stdout.write(`${JSON.stringify(frame(message))}${ending}`);
}

function respond(id, result) {
  write({ id, result: result === undefined ? null : result });
}

function fail(id, code, message, data) {
  write({
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (line.length === 0) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof message.method !== "string") {
    responseCount += 1;
    const pending = pendingServerRequests.get(key(message.id));
    if (pending !== undefined) {
      pendingServerRequests.delete(key(message.id));
      if (Object.hasOwn(message, "error")) {
        respond(pending.outerId, { serverError: message.error });
      } else {
        respond(pending.outerId, { serverResult: message.result });
      }
    }
    return;
  }

  requestCount += 1;
  const hasId = Object.hasOwn(message, "id");
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize":
      if (hasId) {
        respond(message.id, {
          fixture: true,
          receivedJsonrpc: Object.hasOwn(message, "jsonrpc") ? message.jsonrpc : null
        });
      }
      break;

    case "initialized":
      initialized = true;
      break;

    case "fixture/state":
      if (hasId) {
        respond(message.id, { initialized, requestCount, responseCount });
      }
      break;

    case "fixture/echo":
      if (hasId) {
        respond(message.id, params);
      }
      break;

    case "fixture/delay":
      if (hasId) {
        setTimeout(() => respond(message.id, params.value), Number(params.ms ?? 0));
      }
      break;

    case "fixture/serverRequest": {
      if (!hasId) {
        break;
      }
      const serverId = Object.hasOwn(params, "id") ? params.id : `server-${message.id}`;
      pendingServerRequests.set(key(serverId), { outerId: message.id });
      write({
        id: serverId,
        method: "fixture/permission",
        params: { prompt: "approve fixture" }
      });
      break;
    }

    case "fixture/notification":
      write({ method: "fixture/progress", params: { text: "halfway" } });
      if (hasId) {
        respond(message.id, true);
      }
      break;

    case "fixture/unknown":
      write({ fixtureMystery: true, sequence: requestCount });
      if (hasId) {
        respond(message.id, true);
      }
      break;

    case "fixture/orphanResponse":
      write({ id: "fixture-orphan", result: "orphan" });
      if (hasId) {
        respond(message.id, true);
      }
      break;

    case "fixture/stderr": {
      const text = String(params.text ?? "stderr fixture");
      const repeat = Math.max(1, Number(params.repeat ?? 1));
      for (let index = 0; index < repeat; index += 1) {
        process.stderr.write(`${text}\n`);
      }
      if (hasId) {
        respond(message.id, true);
      }
      break;
    }

    case "fixture/framing": {
      const first = Buffer.from(`${JSON.stringify(frame({ method: "fixture/chunk", params: { text: "你🙂" } }))}\r\n`);
      const split = first.indexOf(Buffer.from("🙂")) + 1;
      process.stdout.write(first.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(first.subarray(split));
        process.stdout.write("\n");
        if (hasId) {
          respond(message.id, true);
        }
      }, 5);
      break;
    }

    case "fixture/malformed": {
      const kind = params.kind ?? "syntax";
      if (kind === "badUtf8") {
        process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
      } else if (kind === "overlong") {
        process.stdout.write(`${"x".repeat(Number(params.size ?? 4096))}\n`);
      } else {
        process.stdout.write("{not-json}\n");
      }
      break;
    }

    case "fixture/raw": {
      const kind = params.kind ?? "bothResultAndError";
      if (kind === "bothResultAndError") {
        write({ id: "invalid-shape", result: true, error: { code: -1, message: "also an error" } });
      } else if (kind === "missingId") {
        write({ result: true });
      } else if (kind === "badMethod") {
        write({ id: "invalid-method", method: 42 });
      } else if (kind === "invalidHeader") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "1.0", id: "invalid-header", result: true })}\n`);
      }
      break;
    }

    case "fixture/truncatedExit":
      process.stdout.write('{"jsonrpc":"2.0","id":');
      setTimeout(() => process.exit(24), 5);
      break;

    case "fixture/spawnDescendant": {
      if (!hasId) {
        break;
      }
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true
      });
      respond(message.id, { pid: descendant.pid });
      break;
    }

    case "fixture/hang":
      break;

    case "fixture/exitNow":
      process.exit(Number(params.code ?? 23));
      break;

    case "fixture/shutdown":
      if (hasId) {
        respond(message.id, true);
      }
      setTimeout(() => process.exit(0), 5);
      break;

    default:
      if (hasId) {
        fail(message.id, -32601, `Unknown fixture method: ${message.method}`);
      }
  }
});

input.on("close", () => {
  if (!ignoreEof) {
    clearInterval(heldOpen);
  }
});
