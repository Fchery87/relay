import { rename } from "node:fs/promises";
export async function stageUpgrade(input: { packagePath: string; activePath: string; healthCheck: () => Promise<boolean> }): Promise<void> { await rename(input.packagePath, `${input.activePath}.staged`); if (!(await input.healthCheck())) throw new Error("Staged upgrade health check failed; rollback required"); }
