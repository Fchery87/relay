import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { MachinePlatform } from "@relay/shared";

import { shellInvocation } from "./shell";

export function resolveInsideRoot({ path, root }: { path: string; root: string }): string {
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Path is outside project root");
  }
  return resolved;
}

export async function readProjectFile(input: { path: string; root: string }): Promise<string> {
  return readFile(resolveInsideRoot(input), "utf8");
}

export async function editFile({ content, path, root }: { content: string; path: string; root: string }): Promise<void> {
  const target = resolveInsideRoot({ path, root });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function runCommand({ command, platform, root }: { command: string; platform: MachinePlatform; root: string }) {
  const invocation = shellInvocation({ command, platform });
  const process = Bun.spawn([invocation.executable, ...invocation.args], { cwd: root, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
}
