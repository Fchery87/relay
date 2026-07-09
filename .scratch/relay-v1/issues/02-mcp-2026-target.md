# MCP client target: the 2026-07-28 spec

Type: research
Status: resolved

## Question

The MCP `2026-07-28` release (stateless HTTP core, `Mcp-Method`/`Mcp-Name` routing headers, Tasks extension for long-running work, OAuth/OIDC-aligned authorization, MCP Apps, formal deprecation policy) lands ~3 weeks after this map was charted. What exactly should Relay's v1 MCP client implement — which transports (streamable HTTP, stdio), which extensions (Tasks? never MCP Apps rendering?), which auth flows — and what does building against the RC now require? Deliver a written recommendation as a linked asset, including whether MCP Apps conflicts with the no-live-preview rule.

## Answer

Target `2026-07-28` exclusively (final ships before our MCP ticket is implemented): stateless-first client — `_meta` client info on every request, `Mcp-Method`/`Mcp-Name` headers, `server/discover`, `ttlMs`-respecting tools/list caching; no legacy session support. Transports: streamable HTTP + stdio. Support the Tasks extension as client (task status → thread events). Map multi-round-trip elicitation to the approval-card UI. **MCP Apps: not supported in v1** — it isn't the excluded live-preview feature (that meant previewing the user's own app), but third-party iframe UIs fight the lightweight bar; declining the extension is spec-legal. OAuth: native-app DCR (`application_type: native`), localhost redirect, `iss` validation, refresh tokens — token custody daemon-only. Tool schemas validated as JSON Schema 2020-12, bounded, no external `$ref` fetches. Full notes: [assets/02-mcp-2026-07-28-target.md](../assets/02-mcp-2026-07-28-target.md)
