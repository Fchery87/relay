# Context management strategy for the own loop

Type: grilling
Status: resolved

## Question

Owning the agent loop means owning context: what is Relay's strategy for compaction/summarization when a thread outgrows the model window, token budgeting per turn, tool-result truncation/artifact-spilling (Thanos spills to `.harness/` artifacts), and prompt-cache-aware provider adapters (cache breakpoints, batched system prompts)? This is the largest functional gap in `docs/build-plan.md` for the "powerful" requirement.

## Answer

Grilled and approved 2026-07-09, four decisions:

1. **Summarization compaction.** When a thread outgrows the window, an LLM pass rewrites older history into a structured brief (goal, decisions made, file/artifact pointers, current state); recent turns and pinned material stay verbatim. No sliding-window forgetting, no forced new threads.
2. **Trigger 80% → target ~40%.** Compaction fires when estimated context crosses 80% of the model's window (from catalog metadata), rewriting down to ~40%. Pinned verbatim: system prompt, active plan artifact, unresolved review comments, last 10 turns. Auto-compaction is visible as a thread event; a manual compact action exists in the UI; a pre-turn headroom check prevents mid-turn overflow from large tool results.
3. **Tool-result cap + artifact spilling.** Per-result token cap (order of a few thousand tokens, per-tool tunable). Over-cap output spills to an artifact file in the daemon home; context receives head/tail excerpt + artifact path + size; the agent re-reads ranges on demand. At compaction, old tool results are elided first, down to one-line gists. Full output still streams to the browser via events regardless.
4. **Cache-aware request contract.** Thread context is append-only between compactions (steering and review feedback append, never edit earlier messages); system prompt is byte-stable per thread. Anthropic adapter sets cache_control breakpoints (end of system prompt, conversation tail); OpenAI-style adapters rely on the stable prefix. Cache hit/miss tokens recorded per turn (feeds Usage and cost tracking). Compaction and model-switch are the only accepted full cache invalidations.

Consequences for tickets.md: shapes the loop in "First conversation streams end-to-end" (append-only + budgeting + breakpoints), "Agent acts" (spilling), and "Usage and cost tracking" (cache hit metrics).
