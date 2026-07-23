import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./logger";

describe("redactSecrets", () => {
  test("redacts OpenAI-style, GitHub, and Bearer tokens", () => {
    expect(redactSecrets("key sk-abc123XYZ used")).toBe("key sk-[REDACTED] used");
    expect(redactSecrets("token ghp_abc123XYZ used")).toBe("token ghp_[REDACTED] used");
    expect(redactSecrets("Authorization: Bearer abc123.def456")).toBe("Authorization: Bearer [REDACTED]");
  });

  test("redacts self-hosted Convex admin keys", () => {
    expect(redactSecrets("admin key convex-self-hosted|0ea5efc1a2b3 in use")).toBe(
      "admin key convex-self-hosted|[REDACTED] in use",
    );
  });

  test("redacts device tokens and instance secrets by field name regardless of value format", () => {
    expect(redactSecrets('registering with deviceToken: "no-recognizable-prefix-abc123"')).toBe(
      'registering with deviceToken: "[REDACTED]"',
    );
    expect(redactSecrets("deviceToken=raw-unprefixed-value done")).toBe("deviceToken=[REDACTED] done");
    expect(redactSecrets('{"instanceSecret":"0ea5efc1a2b3"}')).toBe('{"instanceSecret":"[REDACTED]"}');
    expect(redactSecrets("admin_key=abcdef123456")).toBe("admin_key=[REDACTED]");
  });

  test("leaves ordinary log content untouched", () => {
    expect(redactSecrets("Relay daemon connected as dev-machine (mode: kernel)")).toBe(
      "Relay daemon connected as dev-machine (mode: kernel)",
    );
  });
});
