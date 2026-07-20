import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globFind, grepSearch, strReplaceFile } from "./tools";

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "relay-tools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "alpha.ts"), "export const alpha = 1;\nexport const beta = alpha + 1;\n");
  await writeFile(join(root, "src", "beta.md"), "# beta docs\n");
  return root;
}

test("strReplaceFile replaces a unique occurrence", async () => {
  const root = await fixtureRoot();
  const result = await strReplaceFile({ newString: "const alpha = 2", oldString: "const alpha = 1", path: "src/alpha.ts", root });
  expect(result).toContain("Replaced 1 occurrence");
  expect(await readFile(join(root, "src", "alpha.ts"), "utf8")).toContain("const alpha = 2");
});

test("strReplaceFile rejects ambiguous matches without replaceAll", async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, "dup.txt"), "same\nsame\n");
  await expect(strReplaceFile({ newString: "x", oldString: "same", path: "dup.txt", root })).rejects.toThrow("appears 2 times");
  const result = await strReplaceFile({ newString: "x", oldString: "same", path: "dup.txt", replaceAll: true, root });
  expect(result).toContain("Replaced 2 occurrences");
});

test("strReplaceFile creates a file when oldString is empty and file is missing", async () => {
  const root = await fixtureRoot();
  const result = await strReplaceFile({ newString: "hello", oldString: "", path: "brand-new.txt", root });
  expect(result).toContain("Created");
  expect(await readFile(join(root, "brand-new.txt"), "utf8")).toBe("hello");
});

test("strReplaceFile refuses paths outside the project root", async () => {
  const root = await fixtureRoot();
  await expect(strReplaceFile({ newString: "x", oldString: "y", path: "../escape.txt", root })).rejects.toThrow("outside project root");
});

test("grepSearch finds matches with relative paths and reports none cleanly", async () => {
  const root = await fixtureRoot();
  const hit = await grepSearch({ pattern: "const beta", root });
  expect(hit).toContain("alpha.ts");
  expect(hit).not.toContain(root);
  expect(await grepSearch({ pattern: "no-such-string-anywhere", root })).toBe("No matches found.");
});

test("globFind lists matching files and reports none cleanly", async () => {
  const root = await fixtureRoot();
  const hits = await globFind({ pattern: "src/**/*.ts", root });
  expect(hits).toContain("src/alpha.ts");
  expect(hits).not.toContain("beta.md");
  expect(await globFind({ pattern: "**/*.py", root })).toBe("No files matched.");
});
