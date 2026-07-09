# Evaluate Convex first-party components vs hand-rolled tables

Type: research
Status: open

## Question

Should Relay adopt Convex's first-party agent infrastructure — `@convex-dev/agent` (threads/messages), `persistent-text-streaming`, `workflow`/`workpool` (durable execution) — or hand-roll the tables sketched in `docs/build-plan.md`?

Constraint that must anchor the evaluation: Relay's agent loop runs in the **local daemon** because its tools need the local filesystem/shell/git — the Agent component's model of running LLM calls inside Convex actions cannot own the loop wholesale. Evaluate per-component: (a) full adoption, (b) schema/pattern borrowing only, (c) rejection — and what each choice costs in weight, coupling, and migration risk. Deliver a written recommendation as a linked asset.
