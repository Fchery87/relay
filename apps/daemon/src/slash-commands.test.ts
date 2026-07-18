import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandCommand, loadSlashCommands, parseSlashInvocation } from "./slash-commands";

async function commandDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-cmd-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("loadSlashCommands", () => {
  test("loads name from filename, metadata from frontmatter", async () => {
    const dir = await commandDir();
    await writeFile(join(dir, "fix-issue.md"), "---\ndescription: Fix a GitHub issue\nargument-hint: [issue-number]\n---\nFix issue $1 following our conventions.");
    const commands = await loadSlashCommands([{ root: dir, scope: "project" }]);
    expect(commands).toEqual([{ argumentHint: "[issue-number]", description: "Fix a GitHub issue", model: undefined, name: "fix-issue", scope: "project", template: "Fix issue $1 following our conventions." }]);
  });

  test("project scope shadows user scope on name collision", async () => {
    const project = await commandDir();
    const user = await commandDir();
    await writeFile(join(project, "deploy.md"), "---\ndescription: p\n---\nproject deploy");
    await writeFile(join(user, "deploy.md"), "---\ndescription: u\n---\nuser deploy");
    const commands = await loadSlashCommands([{ root: project, scope: "project" }, { root: user, scope: "user" }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.scope).toBe("project");
  });

  test("missing directory yields empty list, not an error", async () => {
    expect(await loadSlashCommands([{ root: "/nonexistent-relay-dir", scope: "user" }])).toEqual([]);
  });
});

describe("parseSlashInvocation / expandCommand", () => {
  test("parses /name plus argument string", () => {
    expect(parseSlashInvocation("/fix-issue 123 high")).toEqual({ args: "123 high", name: "fix-issue" });
    expect(parseSlashInvocation("plain message")).toBeUndefined();
    expect(parseSlashInvocation("/ not-a-command")).toBeUndefined();
  });

  test("substitutes $ARGUMENTS and positional $n", () => {
    expect(expandCommand({ args: "123 high", template: "Fix $1 at priority $2. Context: $ARGUMENTS" }))
      .toBe("Fix 123 at priority high. Context: 123 high");
  });

  test("unused placeholders become empty strings", () => {
    expect(expandCommand({ args: "", template: "Run $1 now" })).toBe("Run  now");
  });
});
