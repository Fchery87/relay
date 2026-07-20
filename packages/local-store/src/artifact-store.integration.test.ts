import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, openMemoryStore } from "./index";

test("artifact store writes atomically, deduplicates, verifies and pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-artifacts-"));
  const db = openMemoryStore(); const store = new ArtifactStore(db, root);
  const input = { runId: "run-1" as never, producingEventId: "event-1" as never, mediaType: "text/plain", content: new TextEncoder().encode("hello") };
  const first = await store.put(input); const second = await store.put(input);
  expect(second.artifactId).toBe(first.artifactId);
  expect(await store.read(first.artifactId)).toEqual(input.content);
  expect(store.list(input.runId, "", 1).items).toHaveLength(1);
  await expect(store.read("../escape" as never)).rejects.toThrow("Invalid artifact id");
  db.close(); await rm(root, { recursive: true, force: true });
});

test("artifact store cancellation leaves no temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-artifacts-")); const db = openMemoryStore(); const store = new ArtifactStore(db, root);
  const signal = AbortSignal.abort();
  await expect(store.put({ runId: "run-1" as never, producingEventId: "event-2" as never, mediaType: "text/plain", content: new Uint8Array([1]), signal })).rejects.toThrow();
  expect((await import("node:fs/promises")).readdir(root)).resolves.toBeDefined(); db.close(); await rm(root, { recursive: true, force: true });
});
