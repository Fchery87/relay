import { join } from "node:path";

export type ExtensionScope = "project" | "user";
export type ExtensionKind = "commands" | "skills";

export function resolveExtensionRoots({ daemonHome, kind, projectRoot, projectTrusted }: {
  daemonHome: string;
  kind: ExtensionKind;
  projectRoot: string;
  projectTrusted: boolean;
}): Array<{ root: string; scope: ExtensionScope }> {
  const roots: Array<{ root: string; scope: ExtensionScope }> = [];
  if (projectTrusted) roots.push({ root: join(projectRoot, ".relay", kind), scope: "project" });
  roots.push({ root: join(daemonHome, kind), scope: "user" });
  return roots;
}
