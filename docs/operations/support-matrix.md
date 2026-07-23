# Relay support matrix

A platform is supported only when `bun run conformance:matrix` passes on that target.

| Platform | Kernel | Fake provider | Codex | Sandbox |
|---|---|---|---|---|
| Linux x64 | Required | Required | Protected CI | bubblewrap or fail closed |
| macOS arm64/x64 | Required | Required | Protected CI | Seatbelt or fail closed |
| Windows x64 | Required | Required | Protected CI | fail closed until AppContainer enforcement |

The matrix validates type checking, deterministic tests, the production
acceptance boundary suites, production build, bundle budget, generated Codex
schema assets, and the security gate. Provider credentials are never required
for the deterministic fake row. The credentialed Codex lifecycle is a separate
manual protected matrix on the same three hosted OS families; each runner must
produce a passing, platform-identified evidence artifact before the provider
gate can be marked complete.
