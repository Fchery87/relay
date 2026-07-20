import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { MachinePlatform } from "@relay/shared";

import { shellInvocation } from "./shell";
import { validateCommand } from "@relay/workspace-runtime";

export function resolveInsideRoot({ path, root }: { path: string; root: string }): string {
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Path is outside project root");
  }
  return resolved;
}

export async function readProjectFile(input: { limit?: number; offset?: number; path: string; root: string }): Promise<string> {
  const MAX_BYTES = 50_000;
  const DEFAULT_LIMIT = 2000;
  const resolved = resolveInsideRoot(input);
  const content = await readFile(resolved, "utf8");
  if (content.length > MAX_BYTES) {
    const truncated = content.slice(0, MAX_BYTES);
    return prefixLineNumbers(truncated, input.offset ?? 1) + "\n[truncated — use offset to continue]";
  }
  const lines = content.split("\n");
  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const sliced = lines.slice(offset - 1, offset - 1 + limit);
  const result = prefixLineNumbers(sliced.join("\n"), offset);
  if (lines.length > offset - 1 + limit) return result + "\n[truncated — use offset to continue]";
  return result;
}

function prefixLineNumbers(text: string, startLine: number): string {
  if (!text) return "";
  return text.split("\n").map((line, index) => `${startLine + index}→ ${line}`).join("\n");
}

export async function editFile({ content, path, root }: { content: string; path: string; root: string }): Promise<void> {
  const target = resolveInsideRoot({ path, root });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function strReplaceFile({ newString, oldString, path, replaceAll, root }: { newString: string; oldString: string; path: string; replaceAll?: boolean; root: string }): Promise<string> {
  const target = resolveInsideRoot({ path, root });
  if (oldString === "") {
    try { await readFile(target, "utf8"); } catch {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, newString, "utf8");
      return `Created ${path}`;
    }
    throw new Error("oldString is empty but the file already exists — provide the text to replace");
  }
  const content = await readFile(target, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error("oldString not found in file — read the file and match its content exactly");
  if (occurrences > 1 && !replaceAll) throw new Error(`oldString appears ${occurrences} times — make it unique or set replaceAll to true`);
  const updated = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
  await writeFile(target, updated, "utf8");
  return `Replaced ${replaceAll ? occurrences : 1} occurrence${(replaceAll ? occurrences : 1) === 1 ? "" : "s"} in ${path}`;
}

export async function grepSearch({ glob, path, pattern, root }: { glob?: string; path?: string; pattern: string; root: string }): Promise<string> {
  const MAX_MATCHES = 200;
  const MAX_BYTES = 20_000;
  const searchRoot = path ? resolveInsideRoot({ path, root }) : root;
  // Args are passed as an array (no shell), so the pattern cannot inject commands.
  const rgArgs = ["--line-number", "--no-heading", "--max-count", "50", "-e", pattern, ...(glob ? ["--glob", glob] : []), searchRoot];
  const grepArgs = ["-rn", "-e", pattern, ...(glob ? [`--include=${glob}`] : []), searchRoot];
  let stdout: string;
  let exitCode: number;
  try {
    const proc = Bun.spawn(["rg", ...rgArgs], { cwd: root, stderr: "pipe", stdout: "pipe" });
    stdout = await new Response(proc.stdout).text();
    exitCode = await proc.exited;
  } catch {
    const proc = Bun.spawn(["grep", ...grepArgs], { cwd: root, stderr: "pipe", stdout: "pipe" });
    stdout = await new Response(proc.stdout).text();
    exitCode = await proc.exited;
  }
  if (exitCode === 1 && !stdout.trim()) return "No matches found.";
  if (exitCode > 1) throw new Error(`Search failed (exit ${exitCode}) — check the pattern syntax`);
  const lines = stdout.split("\n").filter(Boolean).slice(0, MAX_MATCHES)
    .map((line) => line.startsWith(root) ? line.slice(root.length + 1) : line);
  let output = lines.join("\n");
  if (output.length > MAX_BYTES) output = `${output.slice(0, MAX_BYTES)}\n[truncated at 20KB]`;
  return output || "No matches found.";
}

export async function globFind({ pattern, root }: { pattern: string; root: string }): Promise<string> {
  const MAX_RESULTS = 500;
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const file of glob.scan({ cwd: root, dot: false, onlyFiles: true })) {
    matches.push(file);
    if (matches.length >= MAX_RESULTS) break;
  }
  if (matches.length === 0) return "No files matched.";
  return matches.sort().join("\n") + (matches.length >= MAX_RESULTS ? "\n[capped at 500 results]" : "");
}

export async function runCommand({ command, onOutput, platform, root, timeout = 120_000, permissionProfile = "workspace-write" }: {
  command: string;
  onOutput?: (chunk: string) => Promise<void>;
  platform: MachinePlatform;
  root: string;
  timeout?: number;
  permissionProfile?: "read-only" | "workspace-write" | "full-access";
}) {
  const MAX_OUTPUT = 30_000;
  const HEAD_KEEP = 10_000;
  const validation = validateCommand(["sh", "-c", command], permissionProfile);
  if (!validation.allowed) throw new Error(`Sandbox policy denied command: ${validation.reason}`);
  const invocation = shellInvocation({ command, platform });
  const process = Bun.spawn([invocation.executable, ...invocation.args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });

  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => {
    timedOut = true;
    process.kill("SIGKILL");
  }, timeout) : undefined;

  const [stdout, stderr, exitCode] = await Promise.all([
    collectOutput({ onOutput, stream: process.stdout }),
    collectOutput({ onOutput, stream: process.stderr }),
    process.exited,
  ]);

  if (timer) clearTimeout(timer);

  // Cap output
  const combined = stderr ? `${stdout}\n${stderr}` : stdout;
  let output: string;
  let stderrResult: string;
  if (combined.length > MAX_OUTPUT) {
    const head = combined.slice(0, HEAD_KEEP);
    const tail = combined.slice(-(MAX_OUTPUT - HEAD_KEEP));
    output = head + `\n... [truncated] ...\n` + tail;
    stderrResult = "";
  } else {
    output = stdout;
    stderrResult = stderr;
  }

  if (timedOut) {
    output += `\n[timed out after ${Math.round(timeout / 1000)}s]`;
  }

  return { exitCode, stderr: stderrResult, stdout: output };
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
