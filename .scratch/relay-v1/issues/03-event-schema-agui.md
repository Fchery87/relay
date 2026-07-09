# Event schema: adopt AG-UI event types or custom?

Type: grilling
Status: open
Blocked by: 01

## Question

Should the daemon→Convex→browser event stream adopt (or align with) the AG-UI protocol's ~16 standard event types (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, …) instead of a private typed-event schema? AG-UI is transport-agnostic and would buy ecosystem interop; a custom schema can encode Relay-specific concepts (approvals, worktree ops, subagent contracts) natively. Blocked by the Convex-components decision because component adoption may dictate message/event shapes.
