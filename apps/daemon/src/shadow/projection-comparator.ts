import type { CanonicalEventType, EventEnvelope, RunSnapshot } from "@relay/contracts";
import {
  defaultEventComparator,
  defaultSnapshotComparator,
  ShadowRunner,
  type ParityReport,
} from "@relay/orchestration";

export type ShadowProjection = {
  readonly snapshot: RunSnapshot;
  readonly events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>;
};

export type ProjectionComparison = {
  readonly report: ParityReport;
  readonly allowlistRefs: ReadonlyArray<string>;
};

/**
 * The application-level comparator makes the formatting exception explicit.
 * It is deliberately supplied per capture; there is no global "ignore text"
 * mode that could hide a semantic divergence.
 */
export class ProjectionComparator {
  compare(input: {
    readonly kernel: ShadowProjection;
    readonly legacy: ShadowProjection;
    readonly allowFormatting?: boolean;
    readonly allowlistRefs?: ReadonlyArray<string>;
  }): ProjectionComparison {
    const allowFormatting = input.allowFormatting === true;
    const allowlistRefs = allowFormatting
      ? [...(input.allowlistRefs ?? []), "assistant.delta.formatting"]
      : [...(input.allowlistRefs ?? [])];
    const runner = new ShadowRunner({
      compareSnapshots: defaultSnapshotComparator,
      compareEvents: (kernel, legacy) => defaultEventComparator(kernel, legacy, { allowFormatting }),
    });
    return {
      report: runner.run(
        input.kernel.snapshot,
        input.legacy.snapshot,
        input.kernel.events,
        input.legacy.events,
      ),
      allowlistRefs,
    };
  }
}
