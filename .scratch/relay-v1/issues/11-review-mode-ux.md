# Review-mode UX: how one-click review surfaces

Type: grilling
Status: resolved

## Question

How does Relay's review mode surface in the thread UI: which reviewer roles run when the user requests a review of the thread's diff, where do their findings render, and how does the user act on them? Graduated from fog by the role-roster resolution (reviewer + reviewer-security survive as the jury) and the event-schema resolution (findings need an event/comment shape).

## Answer

Jury → inline comments (approved 2026-07-09). A Review action on the thread's diff runs reviewer + reviewer-security (different models, read-only, fresh context) against the worktree. Findings land as inline diff comments in the same comments system that already feeds the agent, graded P0–P3 with P0/P1 given prominence (the signal-over-nits lesson from Codex's review mode). "Address findings" sends unresolved findings into the agent's next turn; each finding traces to its reviewer role in the subagent tree. Single-reviewer and separate-panel options rejected.
