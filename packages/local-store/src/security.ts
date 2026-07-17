// ---------------------------------------------------------------------------
// Security guards — secret scanning, credential hardening, audit completeness.
// ---------------------------------------------------------------------------

export type ThreatBoundary = {
  readonly name: string;
  readonly from: "browser" | "convex" | "daemon" | "provider";
  readonly to: "browser" | "convex" | "daemon" | "provider";
  readonly risks: ReadonlyArray<string>;
  readonly mitigations: ReadonlyArray<string>;
};

/** Relay threat model — trust boundaries. */
export const THREAT_MODEL: ReadonlyArray<ThreatBoundary> = [
  {
    name: "Browser → Convex",
    from: "browser",
    to: "convex",
    risks: ["XSS injecting commands", "CSRF on mutations", "Token exfiltration via JS deps"],
    mitigations: ["Convex Auth with session tokens", "content-security-policy header", "no secrets in browser bundle"],
  },
  {
    name: "Convex → Daemon",
    from: "convex",
    to: "daemon",
    risks: ["Malicious Convex admin injecting commands", "Replayed/fabricated command documents", "Compromised Convex function"],
    mitigations: ["Daemon validates command payloads as untrusted input", "Lease-based command claiming", "Device token scoping"],
  },
  {
    name: "Daemon → Provider",
    from: "daemon",
    to: "provider",
    risks: ["API key leak via argv/ps/lsof", "Token in stdio/stderr", "Prompt injection via user content"],
    mitigations: ["Keys never on argv (environment or stdin)", "Sanitize prompts before provider", "No secrets in logs"],
  },
  {
    name: "Provider → Daemon",
    from: "provider",
    to: "daemon",
    risks: ["Provider output executing commands", "Malicious MCP server responses", "Oversized output DoS"],
    mitigations: ["Sandbox all non-provider commands", "Capability ceiling enforcement", "Output size limits with cap-and-spill"],
  },
];

/** Scan a string for common secret patterns. Returns found patterns (redacted). */
export function scanForSecrets(value: string): string[] {
  const findings: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/sk-[a-zA-Z0-9-]{20,}/, "OpenAI API key"],
    [/sk-ant-[a-zA-Z0-9-]{20,}/, "Anthropic API key"],
    [/ghp_[a-zA-Z0-9]{36}/, "GitHub personal access token"],
    [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "Private key"],
    [/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, "JWT token"],
  ];

  for (const [re, label] of patterns) {
    if (re.test(value)) {
      findings.push(`[REDACTED: ${label}]`);
    }
  }
  return findings;
}

/** Sanitize a value before including in logs or projections. */
export function sanitizeForProjection(value: string): string {
  // Redact common secret patterns
  return value
    .replace(/sk-[a-zA-Z0-9-]{20,}/g, "[REDACTED:api-key]")
    .replace(/sk-ant-[a-zA-Z0-9-]{20,}/g, "[REDACTED:api-key]")
    .replace(/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED:github-token]")
    .replace(/-----BEGIN (RSA |EC )?PRIVATE KEY-----[^-]*-----END (RSA |EC )?PRIVATE KEY-----/gs, "[REDACTED:private-key]");
}
