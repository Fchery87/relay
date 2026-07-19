import type { CommandId, RunId, TurnId } from "./ids";
import type { RunSnapshot } from "./state";

type ReceiptBase = {
  readonly schemaVersion: 1;
  readonly commandId: CommandId;
  readonly runId: RunId;
  readonly snapshot: RunSnapshot;
};

export type SnapshotCommandReceipt = ReceiptBase & {
  readonly kind: "snapshot";
};

export type TurnCommandReceipt = ReceiptBase & {
  readonly kind: "turn";
  readonly turnId: TurnId;
};

/** The immutable result persisted when a command commits. */
export type CommandReceipt = SnapshotCommandReceipt | TurnCommandReceipt;

/** The receipt identity supplied to storage before it assigns commit metadata. */
export type CommandReceiptDraft =
  | { readonly kind: "snapshot" }
  | { readonly kind: "turn"; readonly turnId: TurnId };
