// ---------------------------------------------------------------------------
// Operational wiring tests — verify that observability, security, supervisor,
// and SLO modules are correctly wired into the kernel daemon.
// ---------------------------------------------------------------------------

import { expect, test, describe } from "bun:test";
import {
  scanForSecrets,
  sanitizeForProjection,
} from "@relay/local-store";
import {
  Tracer,
  incrementMetric,
  getMetrics,
} from "@relay/local-store";
import {
  isCompatibleUpgrade,
  parseVersion,
} from "@relay/local-store";
import { SLO_DEFINITIONS } from "@relay/local-store";

// ---------------------------------------------------------------------------
// Security wiring
// ---------------------------------------------------------------------------

describe("Security wiring", () => {
  test("scanForSecrets detects OpenAI API key", () => {
    const findings = scanForSecrets("Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!).toContain("[REDACTED");
  });

  test("scanForSecrets detects Anthropic API key", () => {
    const findings = scanForSecrets("x-api-key: sk-ant-sid01-abcdefghijklmnopqrstuv");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets detects GitHub PAT", () => {
    const findings = scanForSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets detects private key header", () => {
    const findings = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets detects JWT tokens", () => {
    const findings = scanForSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets returns empty for clean text", () => {
    const findings = scanForSecrets("Hello, please write a function to add two numbers.");
    expect(findings).toHaveLength(0);
  });

  test("sanitizeForProjection redacts secrets", () => {
    const sanitized = sanitizeForProjection("My key is sk-proj-abcdefghijklmnopqrstuvwxyz123456 and it's secret");
    expect(sanitized).not.toContain("sk-proj-");
    expect(sanitized).toContain("[REDACTED:api-key]");
  });

  test("sanitizeForProjection redacts GitHub tokens", () => {
    const sanitized = sanitizeForProjection("Use ghp_abcdefghijklmnopqrstuvwxyz1234567890 for auth");
    expect(sanitized).not.toContain("ghp_");
    expect(sanitized).toContain("[REDACTED:github-token]");
  });

  test("sanitizeForProjection redacts private keys", () => {
    const sanitized = sanitizeForProjection("-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n-----END RSA PRIVATE KEY-----");
    expect(sanitized).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(sanitized).toContain("[REDACTED:private-key]");
  });
});

// ---------------------------------------------------------------------------
// Observability wiring
// ---------------------------------------------------------------------------

describe("Observability wiring", () => {
  test("Tracer creates and ends spans", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("test.span");
    expect(span.name).toBe("test.span");
    expect(span.endedAt).toBeUndefined();

    tracer.endSpan(span);
    // Re-fetch span from tracer (endedAt is mutated in place)
    const spans = tracer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.endedAt).toBeDefined();
    expect(spans[0]!.endedAt!).toBeGreaterThan(0);
  });

  test("Tracer supports parent-child spans", () => {
    const tracer = new Tracer();
    const parent = tracer.startSpan("parent");
    const child = tracer.startSpan("child", parent.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
    tracer.endSpan(child);
    tracer.endSpan(parent);

    const spans = tracer.getSpans();
    expect(spans).toHaveLength(2);
  });

  test("Tracer tags are writable", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("tagged");
    span.tags["key"] = "value";
    expect(span.tags["key"]).toBe("value");
  });

  test("getMetrics returns current state with uptime", () => {
    const metrics = getMetrics();
    expect(metrics.uptimeMs).toBeGreaterThan(0);
    expect(typeof metrics.activeRuns).toBe("number");
  });

  test("incrementMetric increases activeRuns", () => {
    const before = getMetrics().activeRuns;
    incrementMetric("activeRuns");
    incrementMetric("activeRuns");
    const after = getMetrics().activeRuns;
    expect(after).toBe(before + 2);
  });

  test("incrementMetric increases completedRuns and eventsProcessed", () => {
    const beforeCompleted = getMetrics().completedRuns;
    const beforeEvents = getMetrics().eventsProcessed;
    incrementMetric("completedRuns");
    incrementMetric("eventsProcessed");
    expect(getMetrics().completedRuns).toBe(beforeCompleted + 1);
    expect(getMetrics().eventsProcessed).toBe(beforeEvents + 1);
  });
});

// ---------------------------------------------------------------------------
// SLO tracking
// ---------------------------------------------------------------------------

describe("SLO wiring", () => {
  test("SLO_DEFINITIONS has prompt-to-first-token-latency", () => {
    const slo = SLO_DEFINITIONS.find((s) => s.name === "prompt-to-first-token-latency");
    expect(slo).toBeDefined();
    expect(slo!.target).toBe(200);
    expect(slo!.unit).toBe("ms");
  });

  test("SLO_DEFINITIONS has command-output-chunk-latency", () => {
    const slo = SLO_DEFINITIONS.find((s) => s.name === "command-output-chunk-latency");
    expect(slo).toBeDefined();
    expect(slo!.target).toBe(200);
  });

  test("SLO_DEFINITIONS has event-append-throughput", () => {
    const slo = SLO_DEFINITIONS.find((s) => s.name === "event-append-throughput");
    expect(slo).toBeDefined();
  });

  test("all SLOs have positive targets", () => {
    for (const slo of SLO_DEFINITIONS) {
      expect(slo.target).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Supervisor / version compatibility
// ---------------------------------------------------------------------------

describe("Version compatibility", () => {
  test("parseVersion parses semver", () => {
    const v = parseVersion("1.2.3");
    expect(v.major).toBe(1);
    expect(v.minor).toBe(2);
    expect(v.patch).toBe(3);
    expect(v.schemaVersion).toBe(3);
  });

  test("isCompatibleUpgrade allows same version", () => {
    const v = parseVersion("2.0.0");
    expect(isCompatibleUpgrade(v, v)).toBe(true);
  });

  test("isCompatibleUpgrade allows minor bump with same schema", () => {
    const current = parseVersion("1.0.0");
    const target = { ...parseVersion("1.1.0"), schemaVersion: 3 };
    expect(isCompatibleUpgrade(current, target)).toBe(true);
  });

  test("isCompatibleUpgrade requires schema >= current for major bump", () => {
    const current = { ...parseVersion("1.0.0"), schemaVersion: 3 };
    const target = { ...parseVersion("2.0.0"), schemaVersion: 3 };
    expect(isCompatibleUpgrade(current, target)).toBe(true);
  });
});
