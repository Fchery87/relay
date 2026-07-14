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

export async function runCommand({ command, onOutput, platform, root }: { command: string; onOutput?: (chunk: string) => Promise<void>; platform: MachinePlatform; root: string }) {
  const invocation = shellInvocation({ command, platform });
  const process = Bun.spawn([invocation.executable, ...invocation.args], { cwd: root, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    collectOutput({ onOutput, stream: process.stdout }),
    collectOutput({ onOutput, stream: process.stderr }),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function collectOutput({ onOutput, stream }: { onOutput?: (chunk: string) => Promise<void>; stream: ReadableStream<Uint8Array> }): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    output += chunk;
    if (chunk) await onOutput?.(chunk);
  }
  const remaining = decoder.decode();
  output += remaining;
  if (remaining) await onOutput?.(remaining);
  return output;
}
