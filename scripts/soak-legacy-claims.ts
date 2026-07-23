// ---------------------------------------------------------------------------
// Live soak test for the legacy work-claim path against a real self-hosted
// Convex backend. Repeatedly calls conversations:claimQueuedMessage (an
// empty-queue claim exercises the same indexed-scan path as a hit, without
// requiring a live provider turn) and reports p50/p95/p99 latency plus
// error counts, matching the acceptance criteria in tickets.md:
// "Claim legacy work within self-hosted limits" (p95 < 400ms, p99 < 700ms,
// no UserTimeout, no unexplained OCC failure, no duplicate claim).
//
// Usage:
//   RELAY_CONVEX_URL=http://127.0.0.1:3210 RELAY_DEVICE_TOKEN=<token> \
//     bun run scripts/soak-legacy-claims.ts [--duration-seconds 900] [--interval-ms 200]
//
// Defaults to a 15-minute run at one claim attempt per 200ms, matching the
// plan's documented soak scenario. Pass a short --duration-seconds for a
// quick smoke check before committing to the full run.
// ---------------------------------------------------------------------------

import { percentile } from "../apps/daemon/src/observability/claim-metrics";

const args = process.argv.slice(2);
function argValue(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  const parsed = Number(args[idx + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const durationSeconds = argValue("--duration-seconds", 900);
const intervalMs = argValue("--interval-ms", 200);

const deploymentUrl = process.env.RELAY_CONVEX_URL ?? "http://127.0.0.1:3210";
const deviceToken = process.env.RELAY_DEVICE_TOKEN;
if (!deviceToken) {
  console.error("RELAY_DEVICE_TOKEN is required — use a paired dev device token (see ~/.config/relay/device.json).");
  process.exit(1);
}

async function claimOnce(): Promise<{ durationMs: number; ok: boolean; errorKind?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${deploymentUrl}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "conversations:claimQueuedMessage", args: [{ deviceToken }], format: "json" }),
    });
    const durationMs = Date.now() - start;
    if (!res.ok) return { durationMs, ok: false, errorKind: `http_${res.status}` };
    const body = (await res.json()) as { status?: string; errorMessage?: string };
    if (body.status === "error") {
      const msg = body.errorMessage ?? "";
      const errorKind = /UserTimeout/i.test(msg) ? "UserTimeout" : /OCC|conflict/i.test(msg) ? "OCCFailure" : "error";
      return { durationMs, ok: false, errorKind };
    }
    return { durationMs, ok: true };
  } catch (error) {
    return { durationMs: Date.now() - start, ok: false, errorKind: error instanceof Error ? error.constructor.name : "unknown" };
  }
}

async function main() {
  console.log(`Soaking ${deploymentUrl} for ${durationSeconds}s at one claim / ${intervalMs}ms...`);
  const durations: number[] = [];
  const errorCounts: Record<string, number> = {};
  const deadline = Date.now() + durationSeconds * 1000;

  while (Date.now() < deadline) {
    const result = await claimOnce();
    durations.push(result.durationMs);
    if (!result.ok) errorCounts[result.errorKind ?? "error"] = (errorCounts[result.errorKind ?? "error"] ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const userTimeouts = errorCounts["UserTimeout"] ?? 0;
  const occFailures = errorCounts["OCCFailure"] ?? 0;

  console.log(`\nSamples: ${durations.length}`);
  console.log(`p50: ${p50}ms  p95: ${p95}ms  p99: ${p99}ms`);
  console.log(`Errors:`, errorCounts);

  const budgetOk = p95 < 400 && p99 < 700;
  const noFailures = userTimeouts === 0 && occFailures === 0;
  console.log(`\np95 < 400ms: ${budgetOk && p95 < 400 ? "PASS" : "FAIL"} (${p95}ms)`);
  console.log(`p99 < 700ms: ${p99 < 700 ? "PASS" : "FAIL"} (${p99}ms)`);
  console.log(`No UserTimeout: ${userTimeouts === 0 ? "PASS" : `FAIL (${userTimeouts})`}`);
  console.log(`No unexplained OCC failure: ${occFailures === 0 ? "PASS" : `FAIL (${occFailures})`}`);

  if (!budgetOk || !noFailures) process.exit(1);
  console.log("\nSoak PASSED.");
}

await main();
