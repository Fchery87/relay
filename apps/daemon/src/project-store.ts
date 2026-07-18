import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRegistrationSchema, type ProjectRegistration } from "@relay/shared";
import { z } from "zod";

const fileSchema = z.object({ projects: z.array(projectRegistrationSchema) });

function storePath(daemonHome: string): string {
  return join(daemonHome, "projects.json");
}

export async function listProjects({ daemonHome, env }: { daemonHome: string; env: Readonly<Record<string, string | undefined>> }): Promise<ProjectRegistration[]> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(storePath(daemonHome), "utf8"))).projects;
  } catch {
    const seed = env.RELAY_PROJECTS ? z.array(projectRegistrationSchema).parse(JSON.parse(env.RELAY_PROJECTS)) : [];
    await save(daemonHome, seed);
    return seed;
  }
}

export async function addProject({ daemonHome, env, name, path }: { daemonHome: string; env: Readonly<Record<string, string | undefined>>; name: string; path: string }): Promise<void> {
  const projects = await listProjects({ daemonHome, env });
  if (projects.some((project) => project.path === path)) throw new Error(`${path} is already registered`);
  await save(daemonHome, [...projects, { name, path }]);
}

export async function removeProject({ daemonHome, env, path }: { daemonHome: string; env: Readonly<Record<string, string | undefined>>; path: string }): Promise<void> {
  await save(daemonHome, (await listProjects({ daemonHome, env })).filter((project) => project.path !== path));
}

async function save(daemonHome: string, projects: ProjectRegistration[]): Promise<void> {
  await writeFile(storePath(daemonHome), JSON.stringify({ projects }, null, 2), "utf8");
}
