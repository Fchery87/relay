import { stat } from "node:fs/promises";
import type { ProjectRegistration } from "@relay/shared";
import { addProject } from "./project-store";

export interface ProjectRequestGateway {
  listPending(input: { deviceToken: string }): Promise<Array<{ id: string; name: string; path: string }>>;
  resolvePending(input: { deviceToken: string; projectId: string; ok: boolean; error?: string }): Promise<unknown>;
}

export async function runQueuedProjectRequest({
  daemonHome,
  env,
  gateway,
}: {
  daemonHome: string;
  env: Readonly<Record<string, string | undefined>>;
  gateway: ProjectRequestGateway;
}): Promise<boolean> {
  const deviceToken = env.RELAY_DEVICE_TOKEN ?? "";
  if (!deviceToken) return false;
  const pending = await gateway.listPending({ deviceToken });
  if (pending.length === 0) return false;

  for (const project of pending) {
    try {
      await stat(project.path);
      // Path exists — add to local store then mark active
      try {
        await addProject({ daemonHome, env, name: project.name, path: project.path });
      } catch (error) {
        if (error instanceof Error && error.message.includes("already registered")) {
          // Already tracked, that's fine
        } else {
          throw error;
        }
      }
      await gateway.resolvePending({ deviceToken, projectId: project.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await gateway.resolvePending({ deviceToken, projectId: project.id, ok: false, error: message });
    }
  }

  return true;
}
