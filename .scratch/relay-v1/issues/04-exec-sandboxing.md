# OS-level exec sandboxing tiers

Type: grilling
Status: open

## Question

The governance chokepoint decides *whether* a command runs; nothing bounds *what a running command can do*. Codex ships seatbelt (macOS), landlock (Linux), and a Windows sandbox as standard. What sandboxing does Relay v1 ship — full OS-sandbox tiers, a reduced subset (e.g. Linux landlock only + documented gaps), or chokepoint-only with sandboxing scheduled for v1.x? Includes: device-token scoping, treatment of commands arriving via Convex state as untrusted input, and secrets-file protection from agent-run commands.
