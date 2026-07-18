import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "./skills";

async function makeSkillRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-skill-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("loadSkills", () => {
  test("loads skill from nested directory with SKILL.md", async () => {
    const dir = await makeSkillRoot();
    const skillDir = join(dir, "my-skill");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: A test skill\n---\nSkill body content.");
    const skills = await loadSkills([{ root: dir, scope: "project" }]);
    expect(skills).toEqual([{ body: "Skill body content.", description: "A test skill", directory: skillDir, name: "my-skill", scope: "project" }]);
  });

  test("project scope shadows user scope", async () => {
    const project = await makeSkillRoot();
    const user = await makeSkillRoot();
    const projDir = join(project, "shared-skill");
    const userDir = join(user, "shared-skill");
    await mkdir(projDir);
    await mkdir(userDir);
    await writeFile(join(projDir, "SKILL.md"), "---\ndescription: project version\n---\nproj");
    await writeFile(join(userDir, "SKILL.md"), "---\ndescription: user version\n---\nuser");
    const skills = await loadSkills([{ root: project, scope: "project" }, { root: user, scope: "user" }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe("project");
  });

  test("skill without description is skipped", async () => {
    const dir = await makeSkillRoot();
    const skillDir = join(dir, "no-desc");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "---\nkey: value\n---\nbody");
    expect(await loadSkills([{ root: dir, scope: "user" }])).toEqual([]);
  });

  test("missing directory yields empty list", async () => {
    expect(await loadSkills([{ root: "/nonexistent-skills", scope: "user" }])).toEqual([]);
  });
});
