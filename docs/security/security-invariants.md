# Security invariants

1. Every external command is authenticated and authorized against its owner, machine, project, run, and requested capability.
2. Provider, MCP, extension, and persisted input is bounded and schema validated before state mutation.
3. Every process executes through a platform sandbox or fails closed.
4. Secrets never enter projections, artifacts previews, diagnostics, argv, or provider-visible history.
5. Approvals are identity- and generation-fenced and can only narrow policy.
6. Audit records are append-only and carry actor, correlation, causation, requested scope, effective scope, and policy version.
7. Shadow mode never executes a second side effect.
8. Recovery never accepts sequence gaps, duplicate effects, stale generations, or cross-run events.
