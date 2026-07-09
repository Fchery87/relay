# Default role roster: which Thanos roles ship in Relay v1?

Type: grilling
Status: resolved

## Question

Which of the 13 Thanos roles (explore, scout, plan, researcher, oracle, reviewer, reviewer-correctness, reviewer-security, reviewer-tests, evaluator, build, worker, designer) ship as Relay's seeded defaults, which get merged or pruned, and do any need adaptation for the browser platform (e.g. scout's `context.md` handoff now that tool results cap-and-spill to artifacts, designer's exec-denied delegation)? Graduated from fog by the context-management resolution, which fixed how role handoffs and artifacts work.

## Answer

Nine roles, pruned (approved 2026-07-09). Ship as seeded defaults: **explore, plan, researcher, oracle, reviewer, reviewer-security, evaluator, build, worker**. Pruned: **scout** (its compressed `context.md` handoff is superseded by cap-and-spill artifacts — explore covers recon), **reviewer-correctness** and **reviewer-tests** (folded into the generalist reviewer; reviewer-security stays separate to preserve the different-model jury value), **designer** (deferred to v1.x — its exec-denied render-delegation dance adds depth-2 complexity v1 doesn't need). Role frontmatter and per-role model tiering port from Thanos otherwise unchanged.
