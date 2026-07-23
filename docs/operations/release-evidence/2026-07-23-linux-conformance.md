# Linux conformance evidence — 2026-07-23

## Executed profile

The supported local Linux profile was run outside the restricted shell so its
loopback HTTP and stdio MCP fixtures could execute:

```text
bun run conformance:matrix
```

Environment: Linux x64, Bun 1.3.14. The profile completed successfully after
the conformance runner enabled `RELAY_REQUIRE_MCP_FIXTURES=1`, which makes the
MCP tests fail rather than silently skip when their deterministic prerequisites
are unavailable.

## Results

- Typecheck: passed for every workspace package.
- Full package and Convex tests: 341 daemon tests passed, 16 intentional
  protected skips, 0 failures; 59 Convex tests passed.
- Deterministic production acceptance: 59 tests passed across three suites.
- MCP HTTP and stdio fixture tests: 2 passed.
- Web production build: passed.
- Bundle budget: passed at 249,268 bytes gzip JavaScript.
- Pinned Codex schema check: passed (`0.144.3`, 267 JSON schemas).
- Security gate: passed.

## Remaining scope

This is local Linux evidence only. Hosted macOS/Windows execution, the real
credentialed Codex provider lifecycle, and the supervised release-window
canary remain required before Ticket 17 or the irreversible Ticket 18 work can
be closed.
