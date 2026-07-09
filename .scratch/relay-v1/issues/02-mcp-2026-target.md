# MCP client target: the 2026-07-28 spec

Type: research
Status: open

## Question

The MCP `2026-07-28` release (stateless HTTP core, `Mcp-Method`/`Mcp-Name` routing headers, Tasks extension for long-running work, OAuth/OIDC-aligned authorization, MCP Apps, formal deprecation policy) lands ~3 weeks after this map was charted. What exactly should Relay's v1 MCP client implement — which transports (streamable HTTP, stdio), which extensions (Tasks? never MCP Apps rendering?), which auth flows — and what does building against the RC now require? Deliver a written recommendation as a linked asset, including whether MCP Apps conflicts with the no-live-preview rule.
