# Usage and cost tracking

Type: grilling
Status: open

## Question

Per-thread token/cost display is standard in every 2026 tool, and `models.json` already carries cost metadata per model. Decide: what usage data the daemon records per turn/thread/subagent (tokens in/out, cache hits, cost), where it lives in the Convex schema, and what the UI surfaces (per-thread total, per-turn breakdown, budget warnings?).
