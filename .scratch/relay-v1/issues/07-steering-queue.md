# Mid-run steering and message-queue semantics

Type: grilling
Status: resolved

## Question

Cursor and Codex both support steering a running agent and queueing follow-up messages. What are Relay's semantics: can a user message interrupt the current turn, inject before the next turn, or only queue until the run completes? How do approvals interact with a queued steer? The loop's turn architecture must account for interrupt/inject from the start — retrofitting is expensive.

## Answer

Queue + turn-boundary inject + explicit Stop (approved 2026-07-09). Messages sent while a run is active queue visibly and inject at the next turn boundary — after the in-flight tool call resolves, before the model plans its next step — preserving the append-only cache contract. A separate Stop control aborts the in-flight LLM stream and safely skips remaining tool calls, leaving the thread awaiting input. Approvals are independent: a queued message never auto-resolves a pending approval card. Hard-interrupt-on-every-message was rejected (wasteful, jittery); queue-only was rejected (can't halt a runaway agent).
