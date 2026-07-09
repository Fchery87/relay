# Event schema: adopt AG-UI event types or custom?

Type: grilling
Status: resolved
Blocked by: 01

## Question

Should the daemon→Convex→browser event stream adopt (or align with) the AG-UI protocol's ~16 standard event types (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, …) instead of a private typed-event schema? AG-UI is transport-agnostic and would buy ecosystem interop; a custom schema can encode Relay-specific concepts (approvals, worktree ops, subagent contracts) natively. Blocked by the Convex-components decision because component adoption may dictate message/event shapes.

## Answer

Custom, AG-UI-aligned (approved 2026-07-09). Relay-native typed events live in the shared zod package — approvals, worktree ops, checkpoints, and subagent contracts are first-class event types, not shoehorned CUSTOM payloads. Where a concept overlaps AG-UI's taxonomy (tool call start/end, streamed message content, run lifecycle), Relay adopts AG-UI's naming and lifecycle semantics so a thin AG-UI adapter can be added later without a rewrite. Full protocol adoption was rejected (Relay-specific concepts dominate); fully-custom naming was rejected (kills the future interop path for free).
