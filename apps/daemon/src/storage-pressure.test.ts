import { expect, test } from "bun:test";
import { storageAdmission } from "./storage-pressure";

test("storage pressure pauses mutation admission below the recovery reserve", () => {
  expect(storageAdmission({ freeBytes: 255 * 1024 * 1024, totalBytes: 10_000, activeRecoveryBytes: 1 })).toEqual({ allowMutation: false, reason: "storage_pressure" });
  expect(storageAdmission({ freeBytes: 512 * 1024 * 1024, totalBytes: 10_000, activeRecoveryBytes: 1 })).toEqual({ allowMutation: true });
});
