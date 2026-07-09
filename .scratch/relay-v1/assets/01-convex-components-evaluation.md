# Research: Convex first-party components vs hand-rolled tables

Sources: convex.dev/components (agent, persistent-text-streaming), docs.convex.dev/agents (+ workflows), get-convex/agent repo. Evaluated 2026-07-09 against the anchor constraint: Relay's loop runs in the local daemon because tools need local filesystem/shell/git.

## Per-component verdict

### @convex-dev/agent — REJECT for the core loop; borrow schema ideas

The Agent component's model: agents are defined in Convex code, LLM calls run inside Convex **actions**, tools are Convex tools executing in the cloud runtime, threads/messages managed by the component with built-in hybrid vector/text search. Every part of that conflicts with Relay's architecture — our LLM calls, tools, and context assembly happen in the daemon, which owns the keys and the filesystem. Adopting it would either move the loop into Convex (impossible: no local FS/shell/git) or leave the component driving nothing.

Borrow instead: its thread/message schema shape (threads shared by multiple agents including humans, messages with parts, per-message agent attribution) is a good reference for our hand-rolled tables. Its vector-search-over-messages idea is noted as a possible later enhancement, not v1.

### @convex-dev/persistent-text-streaming — REJECT the component; adopt its patterns

The component streams from Convex **HTTP actions** (generation happens Convex-side) with a React hook, batched persistence, dedupe/ordering, and resume-from-last-chunk. Our generation happens in the daemon, so the component's HTTP-action pipeline doesn't apply. But its patterns are exactly our spec: batched chunk mutations, explicit ordering keys, dedupe on retry, stream-state markers so an interrupted stream resumes and late-joining browsers see persisted content. Implement those patterns in our own messages/events writes (already decided: ~100–200 ms flushes).

### Workflow / Workpool — DEFER; earmarked for v2 automations

Durable, resumable multi-step execution with retries, surviving restarts — built for jobs that run *inside* Convex. Relay v1's long-running work runs in the daemon, which owns its own resumability (threads persist; daemon restart re-subscribes). When v2 scheduled automations arrive, Convex crons + Workpool are the natural dispatch layer (cron fires → workpool enqueues → daemon picks up), so the schema should keep automation dispatch decoupled enough to slot this in.

## Decision

Hand-rolled tables as specced in the PRD, with three imported patterns: (1) Agent-component-style thread/message shapes, (2) persistent-text-streaming's batched/ordered/resumable chunk writes, (3) automation dispatch left open for Workpool in v2. No first-party component is a runtime dependency in v1.
