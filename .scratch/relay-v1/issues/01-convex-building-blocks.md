# Evaluate Convex first-party components vs hand-rolled tables

Type: research
Status: resolved

## Question

Should Relay adopt Convex's first-party agent infrastructure — `@convex-dev/agent` (threads/messages), `persistent-text-streaming`, `workflow`/`workpool` (durable execution) — or hand-roll the tables sketched in `docs/build-plan.md`?

Constraint that must anchor the evaluation: Relay's agent loop runs in the **local daemon** because its tools need the local filesystem/shell/git — the Agent component's model of running LLM calls inside Convex actions cannot own the loop wholesale. Evaluate per-component: (a) full adoption, (b) schema/pattern borrowing only, (c) rejection — and what each choice costs in weight, coupling, and migration risk. Deliver a written recommendation as a linked asset.

## Answer

Hand-rolled tables win; no Convex first-party component becomes a v1 runtime dependency. `@convex-dev/agent` is rejected for the core loop (its LLM calls/tools run inside Convex actions — incompatible with daemon-owned execution) but its thread/message schema shapes are borrowed. `persistent-text-streaming` is rejected as a component (streams from Convex HTTP actions) but its batched/ordered/deduped/resumable chunk-write patterns are adopted in our own mutations. Workflow/Workpool deferred — earmarked as the v2 automations dispatch layer; keep automation dispatch decoupled in the schema. Full evaluation: [assets/01-convex-components-evaluation.md](../assets/01-convex-components-evaluation.md)
