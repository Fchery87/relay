import type { EventId, RunId } from "./ids";

export type ArtifactId = string & { readonly __artifactId: unique symbol };
export type ArtifactMetadata = Readonly<{
  artifactId: ArtifactId;
  runId: RunId;
  producingEventId: EventId;
  mediaType: string;
  byteLength: number;
  sha256: string;
  preview: string;
  available: boolean;
  createdAt: number;
}>;

export type ArtifactWrite = Readonly<{
  runId: RunId;
  producingEventId: EventId;
  mediaType: string;
  content: Uint8Array;
  signal?: AbortSignal;
}>;
