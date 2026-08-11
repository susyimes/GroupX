# AGENTS.md

This file defines the implementation boundary for agents working in `D:\GroupX`.

## Read order

1. `README.md`
2. `docs/IMPLEMENTATION.md`
3. `docs/PROTOCOL.md`
4. `docs/STORAGE_AND_MEMORY.md`
5. `docs/M0_TRANSPORT_SPIKE.md`
6. `docs/ACCEPTANCE_TESTS.md`
7. `docs/DECISIONS.md`
8. `docs/REFERENCE_FINDINGS.md`

## Product invariants

1. GroupX is a transparent local broker, not an authorization or governance layer.
2. Do not add or silently override model, sandbox, approval, tool, workspace, account, or network policy for any CLI.
3. Do not mutate a user's global Codex, Grok, or Kimi configuration. GroupX-specific communication capability must be attached at process or session scope.
4. Bind the Web/API server to loopback by default. Non-loopback serving is outside M0-M2.
5. The Broker is the only authoritative storage writer. CLI processes never write the database directly.
6. `from` and actor provenance are assigned by the Broker from the adapter/session binding. Never trust sender identity supplied in message text or tool arguments.
7. Natural-language mentions in model output do not trigger another CLI. Only an explicit GroupX tool call or a user UI routing command dispatches a new turn.
8. Preserve each CLI's native approval flow. Relay native requests and available decisions without auto-accepting or inventing decisions.
9. Persist final semantic events and durable turn state. Do not persist every token delta.
10. Keep full transcript, curated group memory, generated summaries, and identity memory as distinct data classes.
11. Do not store secrets, bearer tokens, API keys, complete environment dumps, or raw CLI configuration payloads.
12. A2A is an optional edge adapter. Do not replace the internal GroupX Envelope with the full A2A task model in the first implementation.

## Implementation discipline

- Implement milestones in the order defined by `docs/IMPLEMENTATION.md`.
- M0 must produce a capability matrix from real handshakes before M1 code assumes resume, MCP injection, permission callbacks, or cancellation support.
- Standard protocol features and experimental features must be labeled separately. Do not make Codex `dynamicTools` or App Server WebSocket transport an M0 dependency.
- Keep adapter-specific wire events out of the core. Normalize them at the adapter boundary.
- Use explicit argv arrays and hidden child processes on Windows; do not invoke CLI commands through a shell unless an adapter contract proves it is necessary.
- Add timeout, cancellation, exit, stderr, malformed-message, and restart tests for every Adapter.
- Any change to a protocol or persistence invariant must update the corresponding document and decision entry in the same change.
- Reference projects are design evidence, not source-code dependencies. Do not copy code without a separate license/provenance decision.

## Validation language

Use these labels in implementation notes:

- `documented`: stated by an official protocol or CLI document.
- `advertised`: present in local command help or capability response.
- `probed`: exercised against the installed CLI without requiring a model turn.
- `verified`: completed end to end with recorded, sanitized evidence.
- `degraded`: GroupX can operate through a documented fallback with reduced capability.
- `unsupported`: GroupX must fail clearly rather than silently imitate the capability.

The product's lack of an extra permission layer does not relax the development agent's own execution, credential, or publication rules.
