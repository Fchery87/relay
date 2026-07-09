# Context management strategy for the own loop

Type: grilling
Status: open

## Question

Owning the agent loop means owning context: what is Relay's strategy for compaction/summarization when a thread outgrows the model window, token budgeting per turn, tool-result truncation/artifact-spilling (Thanos spills to `.harness/` artifacts), and prompt-cache-aware provider adapters (cache breakpoints, batched system prompts)? This is the largest functional gap in `docs/build-plan.md` for the "powerful" requirement.
