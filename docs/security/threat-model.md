# Threat model

Trust boundaries are browser↔Convex, Convex↔daemon, daemon↔provider, daemon↔sandboxed process, daemon↔MCP/extension, and local store↔projection. Threats include replay and reordered commands, stolen or revoked device tokens, hostile provider JSON-RPC, malicious MCP schemas/results, traversal and symlink races, inherited credentials, private-network access, output/resource exhaustion, stale leases, cross-run event injection, artifact substitution, and projection secret leakage.

Controls are stable command identities, lease generations, runtime schemas, bounded queues, redaction, content hashes, owner-scoped metadata, platform confinement/fail-closed behavior, append-only canonical history, and deterministic replay. Release blocks on critical/high findings, sandbox escape, sequence gaps, duplicate effects, cross-owner access, or projection divergence.
