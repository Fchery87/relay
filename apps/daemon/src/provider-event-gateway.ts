import type { AppendEventInput, AppendEventResult, LocalHarnessRuntime } from "@relay/harness-runtime";
/** Sole daemon boundary for normalized provider results. Results re-enter through durable, idempotent kernel commands. */
export async function persistProviderEvent(runtime: LocalHarnessRuntime, runId: string, input: AppendEventInput): Promise<AppendEventResult> { return runtime.appendEvent(runId, input); }
