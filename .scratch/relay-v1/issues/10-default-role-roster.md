# Default role roster: which Thanos roles ship in Relay v1?

Type: grilling
Status: open

## Question

Which of the 13 Thanos roles (explore, scout, plan, researcher, oracle, reviewer, reviewer-correctness, reviewer-security, reviewer-tests, evaluator, build, worker, designer) ship as Relay's seeded defaults, which get merged or pruned, and do any need adaptation for the browser platform (e.g. scout's `context.md` handoff now that tool results cap-and-spill to artifacts, designer's exec-denied delegation)? Graduated from fog by the context-management resolution, which fixed how role handoffs and artifacts work.
