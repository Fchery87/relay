# Mid-run steering and message-queue semantics

Type: grilling
Status: open

## Question

Cursor and Codex both support steering a running agent and queueing follow-up messages. What are Relay's semantics: can a user message interrupt the current turn, inject before the next turn, or only queue until the run completes? How do approvals interact with a queued steer? The loop's turn architecture must account for interrupt/inject from the start — retrofitting is expensive.
