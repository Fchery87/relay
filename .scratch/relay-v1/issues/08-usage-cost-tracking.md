# Usage and cost tracking

Type: grilling
Status: resolved

## Question

Per-thread token/cost display is standard in every 2026 tool, and `models.json` already carries cost metadata per model. Decide: what usage data the daemon records per turn/thread/subagent (tokens in/out, cache hits, cost), where it lives in the Convex schema, and what the UI surfaces (per-thread total, per-turn breakdown, budget warnings?).

## Answer

Per-turn records + rollups (approved 2026-07-09). A usage table records one document per LLM call: tokens in/out, cache read/write tokens, thinking tokens, computed cost from catalog metadata, model, and role. Live aggregation per thread, with subagent usage rolling up into the parent thread. UI: thread-header total cost/tokens, expandable per-turn breakdown, cache-hit rate visible (validates the cache-aware request contract from the context-management decision). Optional per-thread budget field warns — does not halt — at threshold; hard spend ceilings deferred.
