# OS-level exec sandboxing tiers

Type: grilling
Status: resolved

## Question

The governance chokepoint decides *whether* a command runs; nothing bounds *what a running command can do*. Codex ships seatbelt (macOS), landlock (Linux), and a Windows sandbox as standard. What sandboxing does Relay v1 ship — full OS-sandbox tiers, a reduced subset (e.g. Linux landlock only + documented gaps), or chokepoint-only with sandboxing scheduled for v1.x? Includes: device-token scoping, treatment of commands arriving via Convex state as untrusted input, and secrets-file protection from agent-run commands.

## Answer

Tiered, unix-first (approved 2026-07-09). v1 ships OS sandboxing for the exec tool on Linux (landlock/bubblewrap) and macOS (seatbelt): filesystem writes confined to the thread worktree + tmp, the daemon secrets directory denied to reads, network per policy. "Run unsandboxed" exists as a per-command escape that always requires an approval card regardless of policy. Windows ships chokepoint-only in v1 with the gap documented; a Windows sandbox (AppContainer/restricted token) is scheduled for v1.x. Device tokens are per-machine, scoped, and revocable from the machines UI. Everything arriving via Convex (messages, commands, approval resolutions) is treated as untrusted input by the daemon — validated against the shared zod schemas, never interpolated into shells.
