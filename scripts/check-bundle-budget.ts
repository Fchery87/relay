import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DEFAULT_PER_ASSET_BUDGET_BYTES = 300 * 1024;
const DEFAULT_TOTAL_BUDGET_BYTES = 600 * 1024;

export type BundleAsset = { gzipBytes: number; path: string };

export async function checkBundleBudget({ directory, perAssetBudgetBytes = DEFAULT_PER_ASSET_BUDGET_BYTES, totalBudgetBytes = DEFAULT_TOTAL_BUDGET_BYTES }: {
  directory: string;
  perAssetBudgetBytes?: number;
  totalBudgetBytes?: number;
}): Promise<{ assets: BundleAsset[]; totalGzipBytes: number }> {
  const files = await findJavaScriptAssets(directory);
  const assets = await Promise.all(files.map(async (file) => ({
    gzipBytes: gzipSync(await readFile(file)).byteLength,
    path: relative(directory, file),
  })));
  assets.sort((left, right) => left.path.localeCompare(right.path));
  for (const asset of assets) {
    if (asset.gzipBytes > perAssetBudgetBytes) {
      throw new Error(`${asset.path} exceeds the per-asset gzip budget (${asset.gzipBytes} > ${perAssetBudgetBytes} bytes)`);
    }
  }
  const totalGzipBytes = assets.reduce((total, asset) => total + asset.gzipBytes, 0);
  if (totalGzipBytes > totalBudgetBytes) {
    throw new Error(`JavaScript assets exceed the total gzip budget (${totalGzipBytes} > ${totalBudgetBytes} bytes)`);
  }
  return { assets, totalGzipBytes };
}

async function findJavaScriptAssets(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptAssets(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  }));
  return files.flat();
}

if (import.meta.main) {
  try {
    const result = await checkBundleBudget({ directory: "apps/web/dist" });
    for (const asset of result.assets) console.log(`${asset.path}: ${asset.gzipBytes} bytes gzip`);
    console.log(`Total JavaScript: ${result.totalGzipBytes} bytes gzip`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Bundle budget check failed");
    process.exitCode = 1;
  }
}
