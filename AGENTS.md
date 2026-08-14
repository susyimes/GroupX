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

1. GroupX is a transparent local broker, not a security, authentication, authorization, or governance boundary.
2. v0.1 has one fixed access policy, `unrestricted`: GroupX must launch each native CLI with the documented maximum-open process/session settings in this repository. Do not expose `access` as a user setting and do not add a second GroupX approval or sandbox policy.
3. GroupX must not write or override a user's global Codex, Grok, Kimi, or Hermes configuration. Apply the fixed unrestricted policy through process argv or native thread/session configuration. Active Structured Kimi accepts official default global settings and establishes `auto` with `session/set_mode` after every new/load; Hermes is launched with `--yolo acp` and establishes `dont_ask` after every new/load. Do not gate either driver on mutable global permission defaults. The deprecated Direct compatibility code may retain a bounded read-only preflight, but it is not a product entry or Structured prerequisite. GroupX cannot bypass Windows UAC, file ACLs, enterprise requirements, server-side policy, or native static deny rules.
4. Bind the Web/API server to loopback by default. Non-loopback serving is outside M0-M2.
5. The Broker is the only authoritative storage writer. CLI processes never write the database directly.
6. `from` and actor provenance are assigned by the Broker from the adapter/session binding. Never take sender identity from message text or tool arguments. A binding is a provenance/correlation handle, not a secret, credential, or defense against a hostile local process.
7. Natural-language mentions in model output do not trigger another CLI. Only an explicit GroupX tool call or a user UI routing command dispatches a new turn.
8. GroupX has no approval subsystem. If a native adapter emits an approval, permission, `requestUserInput`, question, or elicitation request, always fail the current Turn with `UNEXPECTED_NATIVE_INTERACTION` and perform bounded native cancellation/teardown. Do not relay it to the UI, persist a pending request, auto-decide it, or switch transport. `NATIVE_POLICY_BLOCKED` and public state `native_policy_blocked` are a separate path that requires an explicit external-policy preflight or native startup/session refusal; never infer them from an interaction request or its options.
9. Persist final semantic events and durable turn state. Do not persist every token delta.
10. Keep full transcript, curated public memory, per-Agent core memory, per-Agent dated memory, generated summaries, configured Agent identity, and legacy identity records as distinct data classes. Core memory is explicitly curated by the owning Agent or Web operator; dated memory is generated only from a successful Turn's bounded current message and final response. Reasoning and tool records never enter either layer.
11. Collect only fields defined by the GroupX data model. Do not intentionally ingest complete environment dumps, persist raw CLI configuration, or retain unbounded stderr. A bounded parser may read a native config file only to project explicitly allowlisted preflight fields; all other fields stay outside GroupX records and diagnostics. GroupX does not promise to detect or remove secrets that a user or model puts in ordinary message or memory content.
12. A2A is an optional edge adapter. Do not replace the internal GroupX Envelope with the full A2A task model in the first implementation.
13. v0.1 keeps `direct | structured` only as storage/history vocabulary; `structured` is the sole runnable product and release transport. Structured means Codex App Server over stdio plus Grok/Kimi/Hermes ACP over stdio. Direct is deprecated: config parsing, Adapter factory, and runtime construction must reject it before opening runtime resources. Direct source and historical records remain only for audit/migration compatibility; do not restore a runtime entry, feature work, native-live Gate, release claim, or fallback. GroupX MCP current-Turn Agent calls are available only in structured mode.
14. If the selected adapter cannot initialize, establish its native session/process, or honor the unrestricted contract, fail clearly and persist the failure. Once a prompt may have reached a native session/process, reconcile when the selected transport supports it and never automatically replay the prompt as a new native turn.

## Implementation discipline

- Implement milestones in the order defined by `docs/IMPLEMENTATION.md`.
- M0 maintains one active Structured core release baseline from real Codex, Grok, and Kimi runs under the fixed unrestricted policy. A newly added driver such as Hermes must carry its own versioned fixture/no-model probe and must not claim native model/MCP verification until that evidence exists. Direct is marked `DEPRECATED`; prior Direct evidence is historical only and cannot satisfy a current Gate. Native interaction requests must be verified as fail-closed configuration errors, never as an approval-relay feature.
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
- `verified`: completed end to end with recorded, contract-field-bounded evidence.
- `not_observed`: the selected path was exercised, but this native capability did not complete under the recorded configuration; it is neither verified nor a fallback success.
- `unsupported`: GroupX must fail clearly rather than silently imitate the capability.

The product's lack of an extra permission layer does not relax the development agent's own execution, credential, or publication rules.
