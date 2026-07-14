import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBundleBudget } from "./check-bundle-budget";

test("reports gzip sizes for JavaScript build assets within budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-bundle-budget-"));
  await writeFile(join(directory, "app.js"), "console.log('relay')");

  const result = await checkBundleBudget({ directory, perAssetBudgetBytes: 1_000, totalBudgetBytes: 1_000 });

  expect(result.assets).toHaveLength(1);
  expect(result.assets[0]?.path).toBe("app.js");
  expect(result.totalGzipBytes).toBeGreaterThan(0);
});

test("rejects JavaScript assets over the configured gzip budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-bundle-budget-"));
  await writeFile(join(directory, "app.js"), crypto.getRandomValues(new Uint8Array(1_000)));

  await expect(checkBundleBudget({ directory, perAssetBudgetBytes: 100, totalBudgetBytes: 1_000 })).rejects.toThrow("app.js exceeds the per-asset gzip budget");
});
